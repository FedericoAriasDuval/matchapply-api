/**
 * src/lib/extensionTokens.js — lógica PURA de los tokens de la extensión.
 *
 * Sin `db.js` a propósito: importar la base arrastra config.js, que exige
 * DATABASE_URL y revienta en un test unitario. Igual que lib/quota.js, acá vive
 * lo testeable sin base (formato, prefijo, vencimiento); las operaciones contra
 * la tabla están en extensionTokensStore.js. El porqué de la tabla, en
 * db/012_extension_tokens.sql.
 */
import crypto from 'node:crypto';

/** Prefijo humano: hace obvio en un log/DB que es un token de extensión, y deja
 *  al middleware distinguirlo de un JWT sin intentar verificarlo primero. */
export const EXT_PREFIX = 'mavx_';

/** Cuánto vive un token recién emitido, en días. */
export const EXT_TTL_DAYS = 90;

/** sha256 en hex — lo que se guarda en la base (nunca el token en claro). */
export const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

/** ¿Esto tiene pinta de token de extensión? (prefijo + largo mínimo del cuerpo) */
export const esTokenExtension = (raw) =>
  typeof raw === 'string' && raw.startsWith(EXT_PREFIX) && raw.length >= EXT_PREFIX.length + 20;

/** Vencimiento de un token emitido `ahora`. `ahora` es inyectable para testear. */
export const vencimientoExtension = (ttlDays = EXT_TTL_DAYS, ahora = Date.now()) =>
  new Date(ahora + ttlDays * 86_400_000);

/** Genera el token EN CLARO (lo único que el usuario ve; en la base va su hash). */
export const nuevoTokenExtensionRaw = () => EXT_PREFIX + crypto.randomBytes(32).toString('base64url');
