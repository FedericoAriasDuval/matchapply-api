/**
 * src/middleware/extensionAuth.js
 *
 * Autenticación para las rutas de la EXTENSIÓN de Chrome. Aislado del
 * `authenticate` general A PROPÓSITO: ese es el camino por el que pasa TODA
 * petición del sitio, y no se toca por una feature nueva. Acá se acepta:
 *
 *   1) un token opaco de extensión (Authorization: Bearer mavx_…) — el caso real,
 *      porque la cookie httpOnly no viaja desde chrome-extension:// (SameSite);
 *   2) como fallback same-site, la cookie de sesión o un JWT Bearer — sirve para
 *      probar /extension/session desde el propio mavante.com sin emitir token.
 *
 * La carga de req.user es idéntica a la de `authenticate` (mismo SELECT, mismo
 * tier EFECTIVO), para que el candado Pro se resuelva igual en los dos lados.
 */
import { query } from '../db.js';
import { readAccessCookie, verifyAccessToken } from '../lib/tokens.js';
import { SELECT_USER_CON_ACCESO, tierEfectivo } from '../lib/tier.js';
import { esTokenExtension } from '../lib/extensionTokens.js';
import { usuarioDeTokenExtension } from '../lib/extensionTokensStore.js';
import { forbidden, unauthorized } from './errors.js';

export const authenticateExtension = async (req, _res, next) => {
  try {
    const bearer = req.get('authorization')?.replace(/^Bearer\s+/i, '')?.trim();

    let userId;
    if (esTokenExtension(bearer)) {
      userId = await usuarioDeTokenExtension(bearer);
      if (!userId) {
        throw unauthorized('token_invalid', 'La conexión de la extensión venció o se dio de baja. Reconectala desde mavante.com.');
      }
    } else {
      // Fallback same-site: cookie httpOnly o JWT Bearer.
      const token = readAccessCookie(req) ?? bearer;
      if (!token) throw unauthorized();
      try {
        userId = verifyAccessToken(token).sub;
      } catch {
        throw unauthorized('token_invalid', 'Tu sesión expiró. Volvé a iniciar sesión.');
      }
    }

    const { rows } = await query(SELECT_USER_CON_ACCESO, [userId]);
    if (!rows[0]) throw unauthorized();
    if (!rows[0].is_verified) throw forbidden('not_verified', 'Verificá tu email para continuar.');

    const u = rows[0];
    req.user = {
      id: u.id,
      email: u.email,
      name: u.name,
      is_verified: u.is_verified,
      tier: tierEfectivo(u),
      accesoHasta: u.sub_until ?? null,
      accesoTipo: u.sub_provider ?? null,
    };
    next();
  } catch (e) {
    next(e);
  }
};
