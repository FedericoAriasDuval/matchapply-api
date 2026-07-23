import { query } from '../db.js';
import { readAccessCookie, verifyAccessToken } from '../lib/tokens.js';
import { SELECT_USER_CON_ACCESO, tierEfectivo } from '../lib/tier.js';
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

    const { rows } = await query(SELECT_USER_CON_ACCESO, [payload.sub]);
    if (!rows[0]) throw unauthorized();
    if (!rows[0].is_verified) throw forbidden('not_verified', 'Verificá tu email para continuar.');

    /* El tier que rige es el EFECTIVO: un pase semanal vencido deja de ser Pro
       aunque la columna diga 'pro'. Se resuelve en el único lugar por donde pasa
       toda petición autenticada, así ningún candado se olvida de mirar la fecha. */
    const u = rows[0];
    req.user = {
      id: u.id,
      email: u.email,
      name: u.name,
      is_verified: u.is_verified,
      tier: tierEfectivo(u),
      accesoHasta: u.sub_until ?? null,      // lo usa /auth/me para avisar cuándo vence
      accesoTipo: u.sub_provider ?? null,
    };
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
