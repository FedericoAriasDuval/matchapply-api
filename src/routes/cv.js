import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db.js';
import { authenticate, requirePro } from '../middleware/auth.js';
import { aiLimiter } from '../middleware/rateLimit.js';
import { badRequest, forbidden, tooMany } from '../middleware/errors.js';
import { completeJson } from '../lib/llm.js';
import { CV_SYSTEM_PROMPT, CV_TAILOR_PROMPT, buildTailorMessage, buildUserMessage } from '../lib/cvPrompt.js';
import { CvValidationError, sanitizeCv } from '../lib/cvSchema.js';
import { extractText } from '../lib/extract.js';
import { cvCache } from '../lib/cache.js';
import { safeFilename, validateUpload } from '../lib/upload.js';
import { cvQueue } from '../lib/queue.js';
import { decryptJson, decryptText, encryptJson, encryptText } from '../lib/crypto.js';
import { renderCvPdf } from '../lib/pdf.js';
import { renderCvDocx } from '../lib/docx.js';

export const cvRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
});

/* El hash se calcula sobre el texto PLANO, antes de cifrar. Es lo que permite
   deduplicar y usar la caché sin tener que descifrar nada. */
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const today = () => new Date().toISOString().slice(0, 10);

/** Cuota diaria server-side. El cliente nunca decide esto. */
const consumeQuota = async (user) => {
  const limit = user.tier === 'pro' ? config.quota.pro : config.quota.free;
  const { rows } = await query(
    `insert into usage_daily (user_id, day, cv_adaptations)
     values ($1, $2, 1)
     on conflict (user_id, day) do update set cv_adaptations = usage_daily.cv_adaptations + 1
     returning cv_adaptations`,
    [user.id, today()],
  );
  const used = rows[0].cv_adaptations;
  if (used > limit) {
    await query(
      `update usage_daily set cv_adaptations = $3 where user_id = $1 and day = $2`,
      [user.id, today(), limit],
    );
    throw tooMany('quota_exceeded', 'Llegaste a tu límite diario de adaptaciones.', {
      upgrade: user.tier !== 'pro',
      limit,
    });
  }
  return { used, limit, left: limit - used };
};

/* Si la IA fallo, el uso se devuelve. La cuota se cobra ANTES de llamar al
   modelo (para que nadie sobre el limite gaste LLM), pero un error NUESTRO
   no puede costarle un uso al usuario: el 16/07 cinco intentos fallidos
   dejaron una cuenta sin cuota sin haber recibido nada a cambio. */
const refundQuota = async (user) => {
  await query(
    `update usage_daily set cv_adaptations = greatest(cv_adaptations - 1, 0)
      where user_id = $1 and day = $2`,
    [user.id, today()],
  );
};

const getQuota = async (user) => {
  const limit = user.tier === 'pro' ? config.quota.pro : config.quota.free;
  const { rows } = await query(
    `select cv_adaptations from usage_daily where user_id = $1 and day = $2`,
    [user.id, today()],
  );
  const used = rows[0]?.cv_adaptations ?? 0;
  return { used, limit, left: Math.max(0, limit - used) };
};

/**
 * Estructura el CV con el LLM y lo sanea.
 * El modelo NO recibe identidad de la cuenta (ver buildUserMessage): el nombre
 * solo puede salir del texto del CV.
 */
/*
 * Dos capas antes de tocar al LLM, y el orden importa:
 *
 *   1. CACHÉ: si ese CV exacto ya se procesó, se devuelve al instante. Además
 *      deduplica llamadas concurrentes idénticas (dos pestañas, doble clic).
 *   2. COLA: recién si hay que llamar de verdad al modelo, se pide un turno.
 *
 * Al revés estaría mal: haríamos hacer fila a alguien para entregarle algo que
 * ya teníamos guardado.
 */
const structureCv = async (sourceText) =>
  cvCache.wrap(`cv:${sha256(sourceText)}`, () => cvQueue.run(() => structureCvUncached(sourceText)));

/** Llamada real al modelo. La caché de arriba deduplica pedidos idénticos y concurrentes. */
const structureCvUncached = async (sourceText) => {
  const raw = await completeJson({
    system: CV_SYSTEM_PROMPT,
    user: buildUserMessage(sourceText),
  });
  try {
    return sanitizeCv(raw);
  } catch (e) {
    if (e instanceof CvValidationError) {
      throw badRequest('cv_unparsable', 'No pudimos estructurar el CV. Probá con otro archivo.');
    }
    throw e;
  }
};

const saveCv = async (userId, sourceText, data, lang, title = 'CV') => {
  const hash = sha256(sourceText); // sobre el texto plano: deduplica sin descifrar
  const { rows } = await query(
    `insert into cv_documents (user_id, title, source_text, source_hash, lang, data)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (user_id, source_hash)
       do update set data = excluded.data, lang = excluded.lang, edited = false, updated_at = now()
     returning id, title, lang, data, edited, updated_at`,
    /* El CV entra a la base CIFRADO (AES-256-GCM). Un dump de Postgres, un backup
       filtrado o alguien con acceso a la consola ven bytes, no la vida laboral de
       una persona. Es lo que sostiene la promesa que hicimos en la web. */
    [userId, title, encryptText(sourceText), hash, lang, encryptJson(data)],
  );
  const row = rows[0];
  return { ...row, data: decryptJson(row.data) };
};

/** Toda lectura de la base pasa por acá: nadie lee `data` crudo. */
const readCvRow = (row) => (row ? { ...row, data: decryptJson(row.data), source_text: undefined } : row);

// ---------------------------------------------------------------------------
// POST /cv/parse — sube un archivo o manda texto; devuelve el CV estructurado
//   free → la respuesta NO trae el JSON editable, solo un resumen y el id
//   pro  → devuelve el JSON completo para el editor manual
// ---------------------------------------------------------------------------
cvRouter.post('/parse', authenticate, aiLimiter, upload.single('file'), async (req, res, next) => {
  try {
    const lang = (req.body?.lang ?? 'es').slice(0, 2);
    let sourceText;
    if (req.file) {
      validateUpload(req.file);                    // firma binaria + tamaño: no confiamos en el mimetype
      req.file.originalname = safeFilename(req.file.originalname);
      sourceText = await extractText(req.file);
    } else {
      sourceText = String(req.body?.text ?? '').trim();
    }
    if (sourceText.length < 40) throw badRequest('empty_cv', 'Pegá tu CV o subí un archivo con texto.');

    /* si el usuario ya subió este mismo CV, no se vuelve a llamar al modelo ni se consume cuota */
    const { rows: cached } = await query(
      `select id, lang, data, edited from cv_documents where user_id = $1 and source_hash = $2`,
      [req.user.id, sha256(sourceText)],
    );
    if (cached[0] && !cached[0].edited) {
      const doc = readCvRow(cached[0]);   // data viene cifrado de la base: SIEMPRE descifrar antes de usar
      const editable = req.user.tier === 'pro';
      return res.json({
        id: doc.id,
        lang: doc.lang,
        editable,
        cached: true,
        quota: await getQuota(req.user),
        warnings: doc.data.warnings ?? [],
        /* Toda cuenta recibe el CV estructurado: es lo que hace que el
           diagnóstico salga bien. Lo Pro es EDITARLO (PUT) y el DOCX. */
        cv: doc.data,
        preview: { name: doc.data.name, downloadPdf: `/cv/${doc.id}/export?format=pdf` },
      });
    }

    const quota = await consumeQuota(req.user);
    let data;
    try {
      data = await structureCv(sourceText);
    } catch (e) {
      await refundQuota(req.user).catch(() => {});   // el fallo es nuestro, el uso se devuelve
      throw e;
    }
    const doc = await saveCv(req.user.id, sourceText, data, lang);

    /* PAYWALL: lo Pro es EDITAR el CV a mano (PUT /cv/:id) y el DOCX.
       El JSON estructurado va a toda cuenta: sin él, el cliente cae al
       motor local de regex y el diagnóstico sale mal ubicado. */
    const editable = req.user.tier === 'pro';
    res.json({
      id: doc.id,
      lang: doc.lang,
      editable,
      quota,
      warnings: data.warnings,
      cv: data,
      preview: {
        name: data.name,
        sections: {
          experience: data.experience.length,
          education: data.education.length,
          skills: data.skills.length,
        },
        downloadPdf: `/cv/${doc.id}/export?format=pdf`,
        ...(editable ? {} : { upgradeHint: 'Editar el CV a mano es una función Pro.' }),
      },
    });
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// GET /cv/:id — el documento. Free recibe solo metadatos; Pro, el JSON completo.
// ---------------------------------------------------------------------------
cvRouter.get('/:id', authenticate, async (req, res, next) => {
  try {
    const { rows } = await query(
      `select id, title, lang, data, edited, updated_at from cv_documents where id = $1 and user_id = $2`,
      [req.params.id, req.user.id],
    );
    const doc = readCvRow(rows[0]);   // descifrar: en la base vive cifrado
    if (!doc) throw badRequest('cv_not_found', 'No encontramos ese CV.');

    const editable = req.user.tier === 'pro';
    res.json({
      id: doc.id,
      lang: doc.lang,
      edited: doc.edited,
      editable,
      cv: doc.data,   // toda cuenta ve su CV estructurado; editar sigue siendo Pro
      preview: { name: doc.data.name, downloadPdf: `/cv/${doc.id}/export?format=pdf` },
    });
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// PUT /cv/:id — guardar la edición manual. SOLO PRO.
// ---------------------------------------------------------------------------
cvRouter.put('/:id', authenticate, requirePro, async (req, res, next) => {
  try {
    // Se sanea también lo que edita el usuario: el contrato de secciones no se negocia.
    let data;
    try {
      data = sanitizeCv(req.body?.cv);
    } catch (e) {
      throw badRequest('invalid_cv', 'El CV enviado no tiene el formato esperado.');
    }
    const { rows } = await query(
      `update cv_documents set data = $3, edited = true, lang = coalesce($4, lang)
        where id = $1 and user_id = $2
        returning id, lang, edited, updated_at`,
      /* La edicion manual tambien entra CIFRADA: misma promesa que el insert. */
      [req.params.id, req.user.id, encryptJson(data), req.body?.lang ?? null],
    );
    if (!rows[0]) throw badRequest('cv_not_found', 'No encontramos ese CV.');
    res.json({ id: rows[0].id, cv: data, edited: true, updatedAt: rows[0].updated_at });
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// GET /cv/:id/export?format=pdf|docx
//   free → PDF   |   pro → PDF y DOCX
// ---------------------------------------------------------------------------
cvRouter.get('/:id/export', authenticate, async (req, res, next) => {
  try {
    const format = (req.query.format ?? 'pdf').toString().toLowerCase();
    if (!['pdf', 'docx'].includes(format)) throw badRequest('bad_format', 'Formato inválido.');
    if (format === 'docx' && req.user.tier !== 'pro') {
      throw forbidden('pro_required', 'La descarga en DOCX editable es una función Pro.', { upgrade: true });
    }

    const { rows } = await query(
      `select data, lang from cv_documents where id = $1 and user_id = $2`,
      [req.params.id, req.user.id],
    );
    const doc = readCvRow(rows[0]);   // descifrar antes de sanear: en la base vive cifrado
    if (!doc) throw badRequest('cv_not_found', 'No encontramos ese CV.');

    const cv = sanitizeCv(doc.data);
    const safeName = (cv.name || 'CV').replace(/[^\p{L}\p{N}]+/gu, '_').slice(0, 60);
    const file = format === 'pdf' ? await renderCvPdf(cv, doc.lang) : await renderCvDocx(cv, doc.lang);

    res.setHeader(
      'Content-Type',
      format === 'pdf'
        ? 'application/pdf'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}_Mavante.${format}"`);
    res.send(file);
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// POST /cv/:id/tailor — adapta el CV a un aviso (sin inventar habilidades)
// ---------------------------------------------------------------------------
cvRouter.post('/:id/tailor', authenticate, aiLimiter, async (req, res, next) => {
  try {
    const { jobDescription } = z
      .object({ jobDescription: z.string().trim().min(30).max(20_000) })
      .parse(req.body);

    const { rows } = await query(
      `select data, lang from cv_documents where id = $1 and user_id = $2`,
      [req.params.id, req.user.id],
    );
    const doc = readCvRow(rows[0]);   // descifrar: al LLM le llega el JSON, no el cifrado
    if (!doc) throw badRequest('cv_not_found', 'No encontramos ese CV.');

    const quota = await consumeQuota(req.user);
    let out;
    try {
      out = await completeJson({
        system: CV_TAILOR_PROMPT,
        user: buildTailorMessage(doc.data, jobDescription),
      });
    } catch (e) {
      await refundQuota(req.user).catch(() => {});   // el fallo es nuestro, el uso se devuelve
      throw e;
    }

    const tailored = sanitizeCv(out.cv ?? {});
    const editable = req.user.tier === 'pro';

    res.json({
      quota,
      atsScore: Math.max(0, Math.min(100, Number(out.ats_score) || 0)),
      matched: Array.isArray(out.matched_keywords) ? out.matched_keywords.slice(0, 30) : [],
      missing: Array.isArray(out.missing_keywords) ? out.missing_keywords.slice(0, 30) : [],
      reasons: Array.isArray(out.reasons) ? out.reasons.slice(0, 3) : [],
      cv: editable ? tailored : undefined,     // paywall: el JSON editable, solo Pro
    });
  } catch (e) {
    next(e instanceof z.ZodError ? badRequest('invalid_payload', 'Pegá la descripción del puesto.') : e);
  }
});

// ---------------------------------------------------------------------------
// GET /cv — historial · GET /cv/quota/today
// ---------------------------------------------------------------------------
cvRouter.get('/', authenticate, async (req, res, next) => {
  try {
    const limit = req.user.tier === 'pro' ? 50 : 3;   // free ve los últimos 3
    const { rows } = await query(
      `select id, title, lang, edited, updated_at from cv_documents
        where user_id = $1 order by updated_at desc limit $2`,
      [req.user.id, limit],
    );
    res.json({ items: rows, limited: req.user.tier !== 'pro' });
  } catch (e) {
    next(e);
  }
});

cvRouter.get('/quota/today', authenticate, async (req, res, next) => {
  try {
    res.json(await getQuota(req.user));
  } catch (e) {
    next(e);
  }
});
