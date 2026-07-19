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
