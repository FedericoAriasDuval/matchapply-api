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
import { CV_SYSTEM_PROMPT, CV_TAILOR_PROMPT, CV_COVER_PROMPT, CV_INTERVIEW_PROMPT, buildTailorMessage, buildCoverMessage, buildInterviewMessage, buildUserMessage } from '../lib/cvPrompt.js';
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
  /* pro va en la respuesta para que el front reconcilie el tier: el server es la
     fuente de verdad. Sin esto, un USER local viejo puede mostrar el badge/cuota
     equivocados (Pro que se ve "free"). */
  return { used, limit, left: Math.max(0, limit - used), pro: user.tier === 'pro' };
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
const structureCv = async (sourceText, lang) =>
  /* El idioma forma parte de la clave: el mismo CV pedido en es y en en son
     DOS resultados distintos (el modelo traduce el contenido al idioma pedido). */
  cvCache.wrap(`cv:v2:${lang}:${sha256(sourceText)}`, () => cvQueue.run(() => structureCvUncached(sourceText, lang)));

/** Llamada real al modelo. La caché de arriba deduplica pedidos idénticos y concurrentes. */
const structureCvUncached = async (sourceText, lang) => {
  const raw = await completeJson({
    system: CV_SYSTEM_PROMPT,
    user: buildUserMessage(sourceText, lang),
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
  /* El idioma entra a la huella: el mismo CV pedido en es y en en son dos
     documentos distintos (el contenido se traduce). Sigue siendo sobre texto
     plano: deduplica sin descifrar. El prefijo v2 invalida los resultados de
     la era pre-traduccion/pre-primera-persona (16/07): cambia el prefijo si
     el prompt cambia de forma que los resultados guardados queden obsoletos. */
  const hash = sha256(`v2:${lang}\n${sourceText}`);
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

/**
 * Toda lectura de la base pasa por acá: nadie lee `data` crudo.
 *
 * Y si el descifrado falla (clave rotada, fila corrupta), la fila se trata como
 * ILEGIBLE y devuelve null. Antes `decryptJson` devolvía null y ese null seguía
 * viaje como si fuera el CV: seis lugares distintos hacían `doc.data.algo` y
 * reventaban con un 500 genérico ("algo se rompió de nuestro lado"). El chequeo
 * tiene que estar acá, una sola vez, y no repetido en cada handler — que es
 * exactamente el tipo de chequeo que alguien se olvida de poner en el séptimo.
 */
export const readCvRow = (row) => {
  if (!row) return row;
  const data = decryptJson(row.data);
  if (data === null) {
    console.error('[cv] fila ilegible (clave rotada o dato corrupto), cv:', row.id);
    return null;
  }
  return { ...row, data, source_text: undefined };
};

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
      /* El tipo REAL sale de los primeros bytes, no del nombre — y ese tipo es
         el que se le pasa al extractor. Antes se descartaba y el extractor
         volvía a adivinar por la extensión: un PDF llamado "cv.txt" terminaba
         leído como texto y se le mandaba binario al modelo como si fuera un CV. */
      const tipoReal = validateUpload(req.file);
      req.file.originalname = safeFilename(req.file.originalname);
      sourceText = await extractText(req.file, tipoReal);
    } else {
      sourceText = String(req.body?.text ?? '').trim();
    }
    if (sourceText.length < 40) throw badRequest('empty_cv', 'Pegá tu CV o subí un archivo con texto.');

    /* si el usuario ya subió este mismo CV, no se vuelve a llamar al modelo ni se consume cuota */
    const { rows: cached } = await query(
      `select id, lang, data, edited from cv_documents where user_id = $1 and source_hash = $2`,
      [req.user.id, sha256(`v2:${lang}\n${sourceText}`)],   // misma huella version+lang+texto que saveCv
    );
    /* La cache de la base solo vale si es el MISMO idioma: el contenido se
       traduce al idioma pedido, asi que cambiar de idioma re-procesa. */
    /* Si la copia guardada no se puede descifrar, `readCvRow` devuelve null y
       acá NO hay que fallar: seguimos de largo y la regeneramos. Al usuario le
       da igual por qué no servía la de antes; lo que quiere es su diagnóstico.
       (Sí consume cuota, porque hay una llamada real al modelo.) */
    const guardado = (cached[0] && !cached[0].edited && cached[0].lang === lang)
      ? readCvRow(cached[0])
      : null;
    if (guardado) {
      const editable = req.user.tier === 'pro';
      return res.json({
        id: guardado.id,
        lang: guardado.lang,
        editable,
        cached: true,
        quota: await getQuota(req.user),
        warnings: guardado.data.warnings ?? [],
        /* Toda cuenta recibe el CV estructurado: es lo que hace que el
           diagnóstico salga bien. Lo Pro es EDITARLO (PUT) y el DOCX. */
        cv: guardado.data,
        preview: { name: guardado.data.name, downloadPdf: `/cv/${guardado.id}/export?format=pdf` },
      });
    }

    const quota = await consumeQuota(req.user);
    let data;
    try {
      data = await structureCv(sourceText, lang);
    } catch (e) {
      await refundQuota(req.user).catch((e) => console.warn('[quota] no se pudo devolver la cuota:', e?.message));   // el fallo es nuestro, el uso se devuelve
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
    /* `lang` es opcional y gana sobre el idioma del CV: el usuario puede tener
       el CV guardado en español y estar mirando la web en inglés. Si no viene,
       cae al idioma del documento (que es como se venía comportando). */
    const { jobDescription, lang } = z
      .object({
        jobDescription: z.string().trim().min(30).max(20_000),
        lang: z.enum(['es', 'en', 'fr', 'pt']).optional(),
      })
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
        user: buildTailorMessage(doc.data, jobDescription, lang || doc.lang),
      });
    } catch (e) {
      await refundQuota(req.user).catch((e) => console.warn('[quota] no se pudo devolver la cuota:', e?.message));   // el fallo es nuestro, el uso se devuelve
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
// POST /cv/:id/cover — carta de presentación a medida (SOLO PRO)
//   Reemplaza la vieja genCover del frontend (plantilla hardcodeada que
//   elogiaba empresas inventadas). Se apoya solo en el CV real.
// ---------------------------------------------------------------------------
cvRouter.post('/:id/cover', authenticate, requirePro, aiLimiter, async (req, res, next) => {
  try {
    const { jobDescription, tone, lang, draft } = z
      .object({
        jobDescription: z.string().trim().max(20_000).optional().default(''),
        tone: z.enum(['formal', 'creativo', 'corto']).optional().default('formal'),
        lang: z.string().trim().max(2).optional().default('es'),
        // carta que el usuario ya escribió: la IA la MEJORA en vez de escribir de cero
        draft: z.string().trim().max(6_000).optional().default(''),
      })
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
        system: CV_COVER_PROMPT,
        user: buildCoverMessage(doc.data, jobDescription, tone, lang || doc.lang, draft),
      });
    } catch (e) {
      await refundQuota(req.user).catch((e) => console.warn('[quota] no se pudo devolver la cuota:', e?.message));   // el fallo es nuestro, el uso se devuelve
      throw e;
    }

    const letter = String(out.letter ?? '').trim().slice(0, 4000);
    if (!letter) throw badRequest('cover_failed', 'No pudimos generar la carta. Probá de nuevo.');
    res.json({ quota, tone, letter });
  } catch (e) {
    next(e instanceof z.ZodError ? badRequest('invalid_payload', 'Datos inválidos para la carta.') : e);
  }
});

// ---------------------------------------------------------------------------
// POST /cv/:id/interview — simulador de entrevista conversacional (SOLO PRO)
//   Un turno por llamada: el cliente manda el transcript completo (pares q/a) y
//   recibe feedback de la última respuesta + la siguiente pregunta; tras la 5ª,
//   la evaluación final. La cuota se consume UNA vez por entrevista (el primer
//   turno), no por mensaje: si no, una entrevista se comería 5 usos del día.
// ---------------------------------------------------------------------------
/* Token de continuación de entrevista (stateless, HMAC).
   Cierra el bypass de cuota (H2 del audit): la cuota se cobra SOLO al emitir
   este token, en el turno 0 (history vacío + sin token). Para continuar
   (history no vacío) hay que presentar el token; sin él, es una entrevista
   nueva y se cobra igual — mandar history falso ya no sale gratis. El token
   no se puede forjar (HMAC con JWT_SECRET) ni reusar entre usuarios (lleva el
   userId) ni indefinidamente (TTL 1h). Residual conocido y acotado: el replay
   en paralelo del MISMO token da turnos sin cobro, pero lo limita aiLimiter
   (30 req/5min por IP). El fix completo sería estado en DB (fila por entrevista
   con contador atómico) — anotado como follow-up si se observa abuso. */
const IV_TTL_MS = 60 * 60 * 1000;
const signInterviewSession = (userId, turns) => {
  const body = `${userId}.${turns}.${Date.now() + IV_TTL_MS}`;
  const mac = crypto.createHmac('sha256', config.auth.jwtSecret).update(body).digest('base64url');
  return `${Buffer.from(body).toString('base64url')}.${mac}`;
};
/** Turnos ya jugados si el token es válido y del mismo usuario; si no, null. */
const readInterviewSession = (token, userId) => {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const i = token.lastIndexOf('.');
  const b64 = token.slice(0, i), mac = token.slice(i + 1);
  let body;
  try { body = Buffer.from(b64, 'base64url').toString('utf8'); } catch { return null; }
  const expected = crypto.createHmac('sha256', config.auth.jwtSecret).update(body).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const [uid, turnsStr, expStr] = body.split('.');
  if (uid !== String(userId) || Number(expStr) < Date.now()) return null;
  const turns = Number(turnsStr);
  return Number.isFinite(turns) ? turns : null;
};

cvRouter.post('/:id/interview', authenticate, requirePro, aiLimiter, async (req, res, next) => {
  try {
    const { role, context, jobDescription, lang, history, session } = z
      .object({
        role: z.string().trim().max(120).optional().default(''),
        context: z.string().trim().max(30).optional().default('regular'),
        jobDescription: z.string().trim().max(8_000).optional().default(''),
        lang: z.string().trim().max(2).optional().default('es'),
        // token de continuación emitido por el server (ver arriba)
        session: z.string().max(400).optional().default(''),
        history: z
          // q hasta 800: es el largo máximo de pregunta que NOSOTROS emitimos
          // (slice(0,800) en la respuesta). Con 600 acá, una pregunta larga
          // nuestra hacía 400 al volver en el turno siguiente.
          .array(z.object({ q: z.string().trim().max(800), a: z.string().trim().max(2_500) }))
          .max(6)
          .optional()
          .default([]),
      })
      .parse(req.body);

    const { rows } = await query(
      `select data, lang from cv_documents where id = $1 and user_id = $2`,
      [req.params.id, req.user.id],
    );
    const doc = readCvRow(rows[0]);   // descifrar: al LLM le llega el JSON, no el cifrado
    if (!doc) throw badRequest('cv_not_found', 'No encontramos ese CV.');

    // Continuar una entrevista (history no vacío) EXIGE el token que emitimos en
    // el turno 0. Sin token válido, mandar history es un intento de saltear el
    // cobro: se rechaza. El turno 0 real (history vacío + sin token) sí cobra.
    const prevTurns = readInterviewSession(session, req.user.id);
    if (history.length > 0 && prevTurns === null) {
      throw badRequest('interview_session', 'La sesión de entrevista venció o no es válida. Empezá de nuevo.');
    }
    const firstTurn = prevTurns === null;
    const quota = firstTurn ? await consumeQuota(req.user) : undefined;
    let out;
    try {
      out = await completeJson({
        system: CV_INTERVIEW_PROMPT,
        user: buildInterviewMessage(doc.data, { role, context, jobDescription, history, lang: lang || doc.lang }),
      });
    } catch (e) {
      if (firstTurn) await refundQuota(req.user).catch((e) => console.warn('[quota] no se pudo devolver la cuota:', e?.message));   // el fallo es nuestro, el uso se devuelve
      throw e;
    }

    const turnsPlayed = (firstTurn ? 0 : prevTurns) + 1;
    const done = out.done === true || turnsPlayed >= 6 || history.length >= 5;
    const ev = (done && out.evaluation && typeof out.evaluation === 'object') ? out.evaluation : null;
    res.json({
      quota,
      feedback: String(out.feedback ?? '').trim().slice(0, 1_500) || null,
      question: done ? null : (String(out.question ?? '').trim().slice(0, 800) || null),
      done,
      // token para el próximo turno; ausente cuando la entrevista terminó
      session: done ? undefined : signInterviewSession(req.user.id, turnsPlayed),
      evaluation: ev
        ? {
            score: Math.max(0, Math.min(100, Number(ev.score) || 0)),
            strengths: Array.isArray(ev.strengths) ? ev.strengths.slice(0, 4).map((s) => String(s).slice(0, 300)) : [],
            improvements: Array.isArray(ev.improvements) ? ev.improvements.slice(0, 4).map((s) => String(s).slice(0, 300)) : [],
          }
        : null,
    });
  } catch (e) {
    next(e instanceof z.ZodError ? badRequest('invalid_payload', 'Datos inválidos para la entrevista.') : e);
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
