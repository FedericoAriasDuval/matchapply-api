import rateLimit from 'express-rate-limit';

const opts = (windowMs, max, code) => ({
  windowMs,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) =>
    res.status(429).json({
      error: { code, message: 'Demasiados intentos. Esperá unos minutos e intentá de nuevo.' },
    }),
});

/** Registro: 5 cuentas por IP cada 15 minutos. */
export const signupLimiter = rateLimit(opts(15 * 60_000, 5, 'signup_rate_limited'));

/** Login: 10 intentos por IP cada 10 minutos (además del bloqueo por cuenta). */
export const loginLimiter = rateLimit(opts(10 * 60_000, 10, 'login_rate_limited'));

/** Verificación / reenvío: 12 llamadas por IP cada 10 minutos. */
export const codeLimiter = rateLimit(opts(10 * 60_000, 12, 'code_rate_limited'));

/** Endpoints de IA: 30 llamadas por IP cada 5 minutos (la cuota real es por usuario). */
export const aiLimiter = rateLimit(opts(5 * 60_000, 30, 'ai_rate_limited'));

/* Resenas: 5 cada 10 minutos por IP. Suficiente para que alguien deje la suya y
   corrija; insuficiente para inundarnos el feedback y ensuciar el resumen. */
export const reviewLimiter = rateLimit(opts(10 * 60_000, 5, 'review_rate_limited'));

/* Llave de fundador: 20 intentos por IP cada 15 min. El token es largo y
   aleatorio; esto solo le saca al brute-force la fuerza bruta. (Audit L4.) */
export const adminLimiter = rateLimit(opts(15 * 60_000, 20, 'admin_rate_limited'));

/* Webhooks de pago: 60/min por IP. MP/Paddle mandan poco; frena la amplificación
   de fetch salientes con ids arbitrarios hacia la API del proveedor. (Audit M7.) */
export const webhookLimiter = rateLimit(opts(60_000, 60, 'webhook_rate_limited'));
