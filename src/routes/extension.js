import { Router } from 'express';
import { config } from '../config.js';
import { query } from '../db.js';
import { authenticate, requirePro } from '../middleware/auth.js';
import { extensionConnectLimiter } from '../middleware/rateLimit.js';
import { authenticateExtension } from '../middleware/extensionAuth.js';
import { tieneAlMenos } from '../lib/tier.js';
import { crearTokenExtension, revocarTokenExtension } from '../lib/extensionTokensStore.js';
import { readCvRow } from './cv.js';

/* Extensión de Chrome (feature Pro). Flujo real de autenticación:
 *   1) el usuario, logueado y Pro en mavante.com, aprieta "Conectar extensión"
 *      → POST /extension/connect emite un token opaco (mavx_…) y se lo muestra.
 *   2) la extensión guarda ese token y lo manda como Authorization: Bearer en
 *      /extension/session (¿sigo habilitado?) y /extension/cv (datos para rellenar).
 * La cookie httpOnly NO cruza a chrome-extension:// (SameSite=lax), por eso el token.
 * El candado Pro se re-chequea en CADA request (req.user.tier es el EFECTIVO):
 * si el usuario deja de ser Pro, el token sigue siendo válido pero /session y /cv
 * devuelven 403 — el acceso lo manda el plan, no la tenencia del token. */
export const extensionRouter = Router();

/* Respuesta 403 común cuando el usuario está autenticado pero no es Pro. */
const proRequerido = (res) =>
  res.status(403).json({
    ok: false,
    code: 'pro_required',
    message: 'La extensión de Mavante es parte del plan Pro.',
    upgradeUrl: `${config.appUrl}/#precios`,
  });

/* POST /extension/connect  — lo llama el SITIO (cookie), no la extensión.
   Logueado + Pro → emite un token para pegar en la extensión. */
extensionRouter.post('/connect', authenticate, requirePro, extensionConnectLimiter, async (req, res, next) => {
  try {
    const label = String(req.body?.label ?? '').trim().slice(0, 80) || null;
    const { raw, expiresAt } = await crearTokenExtension(req.user.id, label);
    res.json({ ok: true, token: raw, expiresAt });
  } catch (e) {
    next(e);
  }
});

/* GET /extension/session — la extensión pregunta si sigue habilitada.
   - Sin token / token vencido/revocado → 401 (authenticateExtension).
   - Con token, NO Pro                  → 403 con CTA de upgrade.
   - Con token, Pro activo              → 200 con la sesión mínima. */
extensionRouter.get('/session', authenticateExtension, (req, res) => {
  if (!tieneAlMenos(req.user, 'pro')) return proRequerido(res);
  res.json({
    ok: true,
    tier: req.user.tier,
    user: { id: req.user.id, email: req.user.email, name: req.user.name },
    accessUntil: req.user.accesoHasta ?? null,
  });
});

/* GET /extension/cv — SOLO lo que el autofill necesita: nombre + canales de
   contacto. NADA de resumen/experiencia/educación/skills (el autofill no los usa)
   ni source_text ni el cifrado — así un token filtrado expone lo mínimo. */
extensionRouter.get('/cv', authenticateExtension, async (req, res, next) => {
  try {
    if (!tieneAlMenos(req.user, 'pro')) return proRequerido(res);
    const { rows } = await query(
      `select title, lang, data, updated_at from cv_documents
        where user_id = $1 order by updated_at desc limit 1`,
      [req.user.id],
    );
    if (!rows[0]) return res.json({ ok: true, cv: null });

    const doc = readCvRow(rows[0]); // descifra; null si la fila es ilegible (clave rotada)
    if (!doc) return res.json({ ok: true, cv: null });

    const d = doc.data || {};
    res.json({
      ok: true,
      cv: {
        name: d.name ?? '',
        contact: d.contact ?? {},
        lang: doc.lang ?? 'es',
        title: doc.title ?? '',
      },
    });
  } catch (e) {
    next(e);
  }
});

/* POST /extension/disconnect — la extensión revoca SU token (el que presenta). */
extensionRouter.post('/disconnect', authenticateExtension, async (req, res, next) => {
  try {
    const bearer = req.get('authorization')?.replace(/^Bearer\s+/i, '')?.trim();
    await revocarTokenExtension(bearer);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
