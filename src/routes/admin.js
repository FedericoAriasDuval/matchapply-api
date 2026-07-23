import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { badRequest, unauthorized } from '../middleware/errors.js';
import { adminLimiter } from '../middleware/rateLimit.js';

/** Comparación en tiempo constante del token de fundador (Audit L2). */
export const adminTokenOk = (token) => {
  const expected = process.env.ADMIN_TOKEN || '';
  if (!expected) return false;   // sin token configurado, deniega (fail-closed)
  const a = Buffer.from(String(token || '')), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/**
 * Llave de fundador. Protegida con ADMIN_TOKEN (header x-admin-token).
 * NO es un panel: es una llave para los fundadores.
 *
 * Existe porque hasta que los pagos funcionen (Stripe no opera en Argentina),
 * nadie puede volverse Pro por la vía normal. Esto permite comp-ear Pro a
 * testers o fundadores, y probar el camino Pro de punta a punta.
 * Cuando el webhook del proveedor de pagos esté conectado, esto sigue siendo
 * útil para cortesías, pero deja de ser el único camino.
 */
export const adminRouter = Router();

const requireAdmin = (req, _res, next) => {
  if (!adminTokenOk(req.get('x-admin-token'))) {
    return next(unauthorized('admin_only', 'Solo para los fundadores.'));
  }
  next();
};

/* ── Licencias institucionales ──────────────────────────────────────────────
   Se dan de alta A MANO, igual que las empresas del panel de talento y por la
   misma razón: del otro lado hay un contrato firmado y una plata cobrada por
   afuera. No hay auto-registro ni va a haberlo; que una institución exista es
   una decisión de una persona, no el resultado de completar un formulario. */

// POST /admin/licenses  { code, name, maxUsers, validUntil, emailDomain?, notes? }
adminRouter.post('/licenses', adminLimiter, requireAdmin, async (req, res, next) => {
  try {
    const datos = z
      .object({
        code: z.string().trim().min(4).max(64),
        name: z.string().trim().min(2).max(160),
        maxUsers: z.number().int().positive().max(100000),
        /* Fecha del contrato. Se exige explícita: inventarle un default de un año
           a algo que se factura sería comprometer a Mavante con un plazo que
           nadie acordó. */
        validUntil: z.string().trim().min(4),
        emailDomain: z.string().trim().toLowerCase().max(120).optional(),
        notes: z.string().trim().max(500).optional(),
      })
      .parse(req.body);

    const vence = new Date(datos.validUntil);
    if (Number.isNaN(vence.getTime())) {
      throw badRequest('invalid_date', 'validUntil tiene que ser una fecha (2027-03-31).');
    }

    const { rows } = await query(
      `insert into org_licenses (code, name, email_domain, max_users, valid_until, notes)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (code) do update set
         name = excluded.name, email_domain = excluded.email_domain,
         max_users = excluded.max_users, valid_until = excluded.valid_until,
         notes = excluded.notes, is_active = true
       returning id, code, name, email_domain, max_users, valid_until, is_active`,
      [
        datos.code.toUpperCase().replace(/\s+/g, ''),
        datos.name,
        datos.emailDomain?.replace(/^@/, '') || null,
        datos.maxUsers,
        vence,
        datos.notes ?? null,
      ],
    );
    res.json({ ok: true, license: rows[0] });
  } catch (e) {
    next(e instanceof z.ZodError ? badRequest('invalid_payload', 'Mandá code, name, maxUsers y validUntil.') : e);
  }
});

/* GET /admin/licenses — cuántos asientos usó cada institución. Es lo mínimo para
   poder contestar "¿cuántos de los 200 lo están usando?" cuando lo pregunten, sin
   construirles un panel que todavía nadie pidió. */
adminRouter.get('/licenses', adminLimiter, requireAdmin, async (_req, res, next) => {
  try {
    const { rows } = await query(
      `select l.code, l.name, l.email_domain, l.max_users, l.valid_until, l.is_active,
              count(m.user_id)::int as usados
         from org_licenses l
         left join org_license_members m on m.license_id = l.id
        group by l.id
        order by l.created_at desc`,
    );
    res.json({ licenses: rows });
  } catch (e) {
    next(e);
  }
});

// POST /admin/licenses/:code/off  → apaga una licencia (no borra a quien ya canjeó)
adminRouter.post('/licenses/:code/off', adminLimiter, requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await query(
      `update org_licenses set is_active = false where upper(code) = upper($1) returning code, is_active`,
      [String(req.params.code || '')],
    );
    if (!rows[0]) throw badRequest('license_not_found', 'No existe una licencia con ese código.');
    /* A propósito NO se le baja el plan a quien ya canjeó: apagar el código evita
       canjes nuevos, pero quitarle Pro a alguien que lo tenía por un contrato
       vigente sería castigarlo por una decisión administrativa ajena. Cuando
       llegue valid_until, se apaga solo. */
    res.json({ ok: true, license: rows[0] });
  } catch (e) {
    next(e);
  }
});

// POST /admin/tier  { email, tier: 'free'|'pro' }  → setea el plan de una cuenta
adminRouter.post('/tier', adminLimiter, requireAdmin, async (req, res, next) => {
  try {
    const { email, tier } = z
      .object({ email: z.string().trim().email(), tier: z.enum(['free', 'pro']) })
      .parse(req.body);
    const { rows } = await query(
      `update users set tier = $2 where lower(email) = lower($1) returning id, email, tier`,
      [email, tier],
    );
    if (!rows[0]) throw badRequest('user_not_found', 'No hay una cuenta con ese email.');
    res.json({ ok: true, user: rows[0] });
  } catch (e) {
    next(e instanceof z.ZodError ? badRequest('invalid_payload', 'Mandá email y tier (free|pro).') : e);
  }
});
