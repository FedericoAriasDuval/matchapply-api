import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db.js';
import { authenticate, requirePlus, requirePro } from '../middleware/auth.js';
import { tieneAlMenos } from '../lib/tier.js';
import { aiLimiter } from '../middleware/rateLimit.js';
import { badRequest, forbidden, tooMany } from '../middleware/errors.js';
import { completeJson } from '../lib/llm.js';
import { CV_SYSTEM_PROMPT, CV_TAILOR_PROMPT, CV_COVER_PROMPT, CV_INTERVIEW_PROMPT, buildTailorMessage, buildCoverMessage, buildInterviewMessage, buildUserMessage } from '../lib/cvPrompt.js';
import { CvValidationError, sanitizeCv, rescueEducationGrades, normalizeLocaleTerms } from '../lib/cvSchema.js';
import { extractText } from '../lib/extract.js';
import { cvCache } from '../lib/cache.js';
import { safeFilename, validateUpload } from '../lib/upload.js';
import { cvQueue } from '../lib/queue.js';
import { decryptJson, decryptText, encryptJson, encryptText } from '../lib/crypto.js';
import { renderCvPdf } from '../lib/pdf.js';
import { renderCvDocx } from '../lib/docx.js';
import { cvLimitReached } from '../lib/cvLimit.js';

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
/* El fundador (email en FOUNDER_EMAILS) prueba la plataforma sin gastar cuota: ni
   consume ni se topa. Reportamos left alto para que el front nunca lo frene. */
const isFounder = (user) => config.founderEmails.includes(String(user?.email ?? '').toLowerCase());

const consumeQuota = async (user) => {
  if (isFounder(user)) return { used: 0, limit: config.quota.pro, left: 999, pro: true };
  const limit = config.quota[user.tier] ?? config.quota.free;
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
      upgrade: !tieneAlMenos(user, 'pro'),
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
  if (isFounder(user)) return;   // no consumió, no hay nada que devolver
  await query(
    `update usage_daily set cv_adaptations = greatest(cv_adaptations - 1, 0)
      where user_id = $1 and day = $2`,
    [user.id, today()],
  );
};

const getQuota = async (user) => {
  if (isFounder(user)) return { used: 0, limit: config.quota.pro, left: 999, pro: true, tier: user.tier };
  const limit = config.quota[user.tier] ?? config.quota.free;
  const { rows } = await query(
    `select cv_adaptations from usage_daily where user_id = $1 and day = $2`,
    [user.id, today()],
  );
  const used = rows[0]?.cv_adaptations ?? 0;
  /* tier/pro van en la respuesta para que el front reconcilie el plan: el server
     es la fuente de verdad. Sin esto, un USER local viejo muestra el badge/cuota
     equivocados. `pro` se mantiene (compat con el front actual) y significa
     exactamente Pro; `tier` es el plan exacto (free/plus/pro) para el badge. */
  return { used, limit, left: Math.max(0, limit - used), pro: user.tier === 'pro', tier: user.tier };
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

/**
 * HUELLA DEL TEXTO para los logs. Nunca el CV: nunca.
 *
 * Cuando un CV falla en producción, la pregunta es siempre la misma —"¿qué tenía
 * de raro ESE texto?"— y hasta ahora la única respuesta era pedirle el archivo a
 * la persona. Esto responde sin mirar su vida laboral: tamaño, forma y qué clase
 * de basura tipográfica traía. El hash permite reconocer el mismo CV entre líneas
 * de log sin poder reconstruirlo. */
const huellaTexto = (t) => {
  const s = String(t ?? '');
  const lineas = s.split('\n').length;
  const raros = (s.match(new RegExp('[\\uE000-\\uF8FF]', 'g')) || []).length;   // iconos de fuente privada
  const invis = (s.match(new RegExp('[\\u200B-\\u200F\\u202A-\\u202E\\uFEFF\\u00AD]', 'g')) || []).length;
  const emoji = (s.match(/\p{Extended_Pictographic}/gu) || []).length;
  const nonAscii = (s.match(/[^\x00-\x7F]/g) || []).length;
  return `chars=${s.length} lineas=${lineas} largoMedioLinea=${Math.round(s.length / Math.max(1, lineas))} pua=${raros} invis=${invis} emoji=${emoji} noAscii=${nonAscii} sha=${sha256(s).slice(0, 8)}`;
};

/** Llamada real al modelo. La caché de arriba deduplica pedidos idénticos y concurrentes. */
const structureCvUncached = async (sourceText, lang) => {
  const t0 = Date.now();
  const huella = huellaTexto(sourceText);
  let raw;
  try {
    raw = await completeJson({
      system: CV_SYSTEM_PROMPT,
      user: buildUserMessage(sourceText, lang),
    });
  } catch (e) {
    /* QUÉ paso falló y con QUÉ entrada, en una línea. Sin esto, un 502 obligaba
       a pedirle el archivo a la persona para poder reproducirlo. */
    console.error(`[cv:parse] paso=modelo lang=${lang} ${huella} ms=${Date.now() - t0} err=${e?.code ?? e?.name ?? '?'}`);
    throw e;
  }
  try {
    const cv = sanitizeCv(raw);
    /* RED DE SEGURIDAD: el modelo suele tirar el PROMEDIO aunque el prompt lo exija.
       Antes de devolver, releemos el texto original y reinyectamos la nota que el
       modelo dejó vacía. Determinístico: no depende del humor del modelo. */
    rescueEducationGrades(cv, sourceText);
    /* Y el término local del secundario ("High School", no el calco "Secondary
       School") + la unidad del puntaje en el idioma de salida ("204 points"). */
    normalizeLocaleTerms(cv, lang);
    /* Una traza también cuando SALE BIEN pero sale flaco: un CV que vuelve sin
       experiencia ni skills es exactamente el que produce "no se detectan las
       secciones estándar" en la pantalla, y hasta ahora no dejaba rastro. */
    if (!cv.experience.length || !cv.skills.length) {
      console.warn(`[cv:parse] paso=ok-pero-flaco lang=${lang} ${huella} exp=${cv.experience.length} edu=${cv.education.length} skills=${cv.skills.length} ms=${Date.now() - t0}`);
    }
    return cv;
  } catch (e) {
    if (e instanceof CvValidationError) {
      /* El modelo contestó pero su JSON no cumple el contrato. Es un fallo
         distinto del de arriba y hay que poder distinguirlos en el log. */
      console.error(`[cv:parse] paso=schema lang=${lang} ${huella} ms=${Date.now() - t0} detalle=${String(e.message).slice(0, 200)}`);
      throw badRequest('cv_unparsable', 'No pudimos estructurar el CV. Probá con otro archivo.');
    }
    console.error(`[cv:parse] paso=sanitize-inesperado lang=${lang} ${huella} err=${e?.name ?? '?'}`);
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
    // lang al set conocido (un valor raro caía en español igual, pero mejor no guardarlo)
    const lang = ['es', 'en', 'fr', 'pt', 'it'].includes(req.body?.lang) ? req.body.lang : 'es';
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
      // Texto pegado: tope explícito en la ingesta (60k = lo mismo que ve el modelo).
      // Sin esto se guardaba hasta 1MB (el límite del body) tal cual en source_text.
      sourceText = String(req.body?.text ?? '').trim().slice(0, 60_000);
    }
    if (sourceText.length < 40) throw badRequest('empty_cv', 'Pegá tu CV o subí un archivo con texto.');

    /* si el usuario ya subió este mismo CV, no se vuelve a llamar al modelo ni se consume cuota */
    const { rows: cached } = await query(
      `select id, lang, data, edited from cv_documents where user_id = $1 and source_hash = $2`,
      [req.user.id, sha256(`v2:${lang}\n${sourceText}`)],   // misma huella version+lang+texto que saveCv
    );
    /* TOPE DE CANTIDAD: un CV NUEVO (source_hash inexistente) ocupa un slot del panel.
       Re-parsear uno que ya existe (cache) NO cuenta: el on-conflict actualiza la misma
       fila. El fundador y Pro no se topan. Server-autoritativo, igual que la cuota. */
    const cvCap = config.cvLimit[req.user.tier] ?? config.cvLimit.free;
    if (!cached[0] && !isFounder(req.user) && Number.isFinite(cvCap)) {   // fundador y tiers sin tope (Infinity): ni consultamos la base
      const { rows: cnt } = await query('select count(*)::int n from cv_documents where user_id = $1', [req.user.id]);
      if (cvLimitReached({ isFounder: false, tier: req.user.tier, count: cnt[0].n, limits: config.cvLimit })) {
        throw forbidden('cv_limit', 'Llegaste al máximo de CVs de tu plan.', { upgrade: !tieneAlMenos(req.user, 'pro'), limit: cvCap });
      }
    }
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
      /* Un CV parseado ANTES de esta red (era grade-less) sigue guardado sin la
         nota. La rescatamos también acá, sobre el texto de este mismo pedido (que
         por definición coincide con el guardado — por eso pegó la caché): es
         determinístico y gratis, sin llamar al modelo ni cobrar cuota. Así la nota
         reaparece al re-subir el mismo CV, no recién al cambiarle una coma. */
      rescueEducationGrades(guardado.data, sourceText);
      normalizeLocaleTerms(guardado.data, guardado.lang);   // término del secundario + unidad del puntaje
      const editable = tieneAlMenos(req.user, 'plus');
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
    let data, doc;
    try {
      data = await structureCv(sourceText, lang);
      doc = await saveCv(req.user.id, sourceText, data, lang);   // DENTRO del try: si el guardado/cifrado falla, la cuota se devuelve igual (antes quedaba afuera y cobraba un uso perdido)
    } catch (e) {
      await refundQuota(req.user).catch((e) => console.warn('[quota] no se pudo devolver la cuota:', e?.message));   // el fallo es nuestro, el uso se devuelve
      throw e;
    }

    /* PAYWALL: editar el CV a mano (PUT /cv/:id) y el DOCX son de pago (Plus+).
       El JSON estructurado va a toda cuenta: sin él, el cliente cae al
       motor local de regex y el diagnóstico sale mal ubicado. */
    const editable = tieneAlMenos(req.user, 'plus');
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
        ...(editable ? {} : { upgradeHint: 'Editar el CV a mano es una función de pago (Plus o Pro).' }),
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
      `select id, title, source_text, lang, data, edited, updated_at from cv_documents where id = $1 and user_id = $2`,
      [req.params.id, req.user.id],
    );
    const doc = readCvRow(rows[0]);   // descifrar el data: en la base vive cifrado
    if (!doc) throw badRequest('cv_not_found', 'No encontramos ese CV.');

    const editable = tieneAlMenos(req.user, 'plus');
    res.json({
      id: doc.id,
      title: doc.title,
      lang: doc.lang,
      edited: doc.edited,
      editable,
      /* El texto fuente (descifrado) hace falta para REABRIR el CV en el panel: el
         textarea se vuelve a llenar con él y desde ahí se re-arma el diagnóstico. */
      sourceText: decryptText(rows[0].source_text),
      cv: doc.data,   // toda cuenta ve su CV estructurado; editar sigue siendo Pro
      preview: { name: doc.data.name, downloadPdf: `/cv/${doc.id}/export?format=pdf` },
    });
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// PUT /cv/:id — guardar la edición manual. Plus o superior (editar a mano es Plus).
// ---------------------------------------------------------------------------
cvRouter.put('/:id', authenticate, requirePlus, async (req, res, next) => {
  try {
    // Se sanea también lo que edita el usuario: el contrato de secciones no se negocia.
    let data;
    try {
      data = sanitizeCv(req.body?.cv);
    } catch (e) {
      throw badRequest('invalid_cv', 'El CV enviado no tiene el formato esperado.');
    }
    /* lang validado contra el set conocido. Sin esto, un lang basura o gigante
       (req.body.lang no pasaba por zod) se guardaba tal cual en cv_documents.lang y
       de ahí iba al render del PDF/DOCX y de vuelta al frontend en cada GET. null =
       dejar el idioma que ya tenía (coalesce). */
    const nextLang = ['es', 'en', 'fr', 'pt', 'it'].includes(req.body?.lang) ? req.body.lang : null;
    const { rows } = await query(
      `update cv_documents set data = $3, edited = true, lang = coalesce($4, lang)
        where id = $1 and user_id = $2
        returning id, lang, edited, updated_at`,
      /* La edicion manual tambien entra CIFRADA: misma promesa que el insert. */
      [req.params.id, req.user.id, encryptJson(data), nextLang],
    );
    if (!rows[0]) throw badRequest('cv_not_found', 'No encontramos ese CV.');
    res.json({ id: rows[0].id, cv: data, edited: true, updatedAt: rows[0].updated_at });
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// DELETE /cv/:id — borrar un CV del panel. Free y Pro. Libera un slot del tope.
// El filtro por user_id (como en todo el archivo) impide borrar el CV de otro.
// ---------------------------------------------------------------------------
cvRouter.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const { rows } = await query(
      `delete from cv_documents where id = $1 and user_id = $2 returning id`,
      [req.params.id, req.user.id],
    );
    if (!rows[0]) throw badRequest('cv_not_found', 'No encontramos ese CV.');
    res.json({ ok: true, id: rows[0].id });
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// PATCH /cv/:id/title — renombrar. Es GESTIÓN del panel, no editar el CV, así que va
// a TODA cuenta (a diferencia de PUT, que edita el contenido y es Pro). El título NUNCA
// se muestra en el CV renderizado ni en el PDF: es solo para organizar el panel.
// ---------------------------------------------------------------------------
cvRouter.patch('/:id/title', authenticate, async (req, res, next) => {
  try {
    const { title } = z.object({ title: z.string().trim().min(1).max(60) }).parse(req.body);
    const { rows } = await query(
      `update cv_documents set title = $3 where id = $1 and user_id = $2 returning id, title`,
      [req.params.id, req.user.id, title],
    );
    if (!rows[0]) throw badRequest('cv_not_found', 'No encontramos ese CV.');
    res.json({ id: rows[0].id, title: rows[0].title });
  } catch (e) {
    next(e instanceof z.ZodError ? badRequest('invalid_payload', 'El título tiene que tener entre 1 y 60 caracteres.') : e);
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
    if (format === 'docx' && !tieneAlMenos(req.user, 'plus')) {
      throw forbidden('plus_required', 'La descarga en DOCX editable es una función de pago (Plus o Pro).', { upgrade: true, tier: 'plus' });
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
        lang: z.enum(['es', 'en', 'fr', 'pt', 'it']).optional(),   // it: faltaba y un usuario en italiano recibía 400 en el adaptador (Pro)
      })
      .parse(req.body);

    const { rows } = await query(
      `select data, lang from cv_documents where id = $1 and user_id = $2`,
      [req.params.id, req.user.id],
    );
    const doc = readCvRow(rows[0]);   // descifrar: al LLM le llega el JSON, no el cifrado
    if (!doc) throw badRequest('cv_not_found', 'No encontramos ese CV.');

    const quota = await consumeQuota(req.user);
    let out, tailored;
    try {
      out = await completeJson({
        system: CV_TAILOR_PROMPT,
        user: buildTailorMessage(doc.data, jobDescription, lang || doc.lang),
      });
      tailored = sanitizeCv(out.cv ?? {});   // DENTRO del try: si el modelo devolvió un cv inválido, la cuota se devuelve (antes tiraba sin refund)
    } catch (e) {
      await refundQuota(req.user).catch((e) => console.warn('[quota] no se pudo devolver la cuota:', e?.message));   // el fallo es nuestro, el uso se devuelve
      throw e;
    }

    const editable = tieneAlMenos(req.user, 'plus');

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
    let letter;
    try {
      const out = await completeJson({
        system: CV_COVER_PROMPT,
        user: buildCoverMessage(doc.data, jobDescription, tone, lang || doc.lang, draft),
      });
      letter = String(out.letter ?? '').trim().slice(0, 4000);
      if (!letter) throw badRequest('cover_failed', 'No pudimos generar la carta. Probá de nuevo.');   // DENTRO del try: carta vacía = fallo nuestro, se devuelve la cuota
    } catch (e) {
      await refundQuota(req.user).catch((e) => console.warn('[quota] no se pudo devolver la cuota:', e?.message));   // el fallo es nuestro, el uso se devuelve
      throw e;
    }
    res.json({ quota, tone, letter });
  } catch (e) {
    next(e instanceof z.ZodError ? badRequest('invalid_payload', 'Datos inválidos para la carta.') : e);
  }
});

// ---------------------------------------------------------------------------
// POST /cv/:id/interview — simulador de entrevista conversacional (Plus o superior)
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

cvRouter.post('/:id/interview', authenticate, requirePlus, aiLimiter, async (req, res, next) => {
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
    const limit = tieneAlMenos(req.user, 'plus') ? 50 : 3;   // free ve los últimos 3; Plus/Pro, hasta 50
    const { rows } = await query(
      `select id, title, lang, data, edited, updated_at from cv_documents
        where user_id = $1 order by updated_at desc limit $2`,
      [req.user.id, limit],
    );
    /* Cada item lleva un PREVIEW recortado del CV (descifrado) para dibujar la
       miniatura tipo PDF en el panel "Mis CVs" sin una llamada por tarjeta. Es a
       propósito recortado: el thumbnail solo muestra la parte de arriba de la hoja,
       no hace falta viajar el CV entero por cada uno. Si la fila es ilegible
       (readCvRow → null), preview va null y el front dibuja un placeholder. */
    const items = rows.map((row) => {
      const doc = readCvRow(row);
      const d = doc && doc.data ? doc.data : null;
      const preview = d
        ? {
            name: d.name || '',
            contactLine: d.contactLine || '',
            summary: d.summary || '',
            experience: Array.isArray(d.experience)
              ? d.experience.slice(0, 3).map((x) => ({
                  role: x.role || '',
                  company: x.company || '',
                  dates: x.dates || '',
                  location: x.location || '',
                  bullets: Array.isArray(x.bullets) ? x.bullets.slice(0, 4) : [],
                }))
              : [],
            education: Array.isArray(d.education)
              ? d.education.slice(0, 2).map((x) => ({
                  title: x.title || '',
                  detail: x.detail || '',
                  dates: x.dates || '',
                  location: x.location || '',
                  grade: x.grade || '',
                }))
              : [],
            skills: Array.isArray(d.skills) ? d.skills.slice(0, 12) : [],
            languages: Array.isArray(d.languages) ? d.languages.slice(0, 8) : [],
          }
        : null;
      return {
        id: row.id,
        title: row.title,
        lang: row.lang,
        edited: row.edited,
        updated_at: row.updated_at,
        preview,
      };
    });
    res.json({ items, limited: !tieneAlMenos(req.user, 'plus') });
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
