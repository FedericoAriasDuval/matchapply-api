import { query } from '../db.js';
import { readAccessCookie, verifyAccessToken } from '../lib/tokens.js';
import { forbidden, unauthorized } from './errors.js';

/** Carga req.user desde la cookie de acceso (o el header Bearer). */
export const authenticate = async (req, _res, next) => {
  try {
    const bearer = req.get('authorization')?.replace(/^Bearer\s+/i, '');
    const token = readAccessCookie(req) ?? bearer;
    if (!token) throw unauthorized();

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch {
      throw unauthorized('token_invalid', 'Tu sesión expiró. Volvé a iniciar sesión.');
    }

    const { rows } = await query(
      `select id, email, name, tier, is_verified from users where id = $1`,
      [payload.sub],
    );
    if (!rows[0]) throw unauthorized();
    if (!rows[0].is_verified) throw forbidden('not_verified', 'Verificá tu email para continuar.');

    req.user = rows[0];
    next();
  } catch (e) {
    next(e);
  }
};

/** Exige tier = 'pro'. El paywall se decide SIEMPRE en el servidor. */
export const requirePro = (req, _res, next) => {
  if (req.user?.tier !== 'pro') {
    return next(
      forbidden('pro_required', 'Esta función es exclusiva de Mavante Pro.', { upgrade: true }),
    );
  }
  next();
};
