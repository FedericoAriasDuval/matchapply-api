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
