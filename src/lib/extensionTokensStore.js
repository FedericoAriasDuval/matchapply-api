/**
 * src/lib/extensionTokensStore.js — operaciones contra la tabla extension_tokens.
 *
 * Separado de la lógica pura (extensionTokens.js) porque esto SÍ importa la base;
 * meterlo junto haría que un test unitario de la parte pura arrastrara config.js
 * y su exigencia de DATABASE_URL. La tabla y su porqué: db/012_extension_tokens.sql.
 */
import { query } from '../db.js';
import {
  EXT_TTL_DAYS,
  hashToken,
  esTokenExtension,
  nuevoTokenExtensionRaw,
  vencimientoExtension,
} from './extensionTokens.js';

/** Cuántos tokens VIVOS puede tener un usuario a la vez (evita el sprawl de
 *  credenciales si una sesión comprometida spamea /connect). */
const MAX_TOKENS_VIVOS = 10;

/** Emite un token para `userId`, lo guarda HASHEADO y devuelve el token EN CLARO
 *  (única vez que se puede ver) + su vencimiento. Antes de emitir hace higiene:
 *  borra los muertos del usuario y, si ya llegó al tope, revoca el más viejo — así
 *  la tabla no crece sin fin ni quedan decenas de credenciales de 90 días vivas. */
export const crearTokenExtension = async (userId, label = null, ttlDays = EXT_TTL_DAYS) => {
  // 1) basura: tokens ya vencidos o revocados de este usuario, fuera.
  await query(
    `delete from extension_tokens where user_id = $1 and (revoked_at is not null or expires_at <= now())`,
    [userId],
  );
  // 2) tope: si ya tiene MAX vivos, revocar los más viejos para que tras insertar quede en MAX.
  await query(
    `update extension_tokens set revoked_at = now()
      where token_hash in (
        select token_hash from extension_tokens
         where user_id = $1 and revoked_at is null and expires_at > now()
         order by created_at desc offset $2
      )`,
    [userId, MAX_TOKENS_VIVOS - 1],
  );

  const raw = nuevoTokenExtensionRaw();
  const expiresAt = vencimientoExtension(ttlDays);
  await query(
    `insert into extension_tokens (token_hash, user_id, label, expires_at) values ($1, $2, $3, $4)`,
    [hashToken(raw), userId, label, expiresAt],
  );
  return { raw, expiresAt };
};

/** Devuelve el user_id si el token vive (no revocado, no vencido) y marca el uso.
 *  null si no sirve. Un solo UPDATE ... RETURNING: validar y sellar el uso en el
 *  mismo paso, sin condición de carrera. */
export const usuarioDeTokenExtension = async (raw) => {
  if (!esTokenExtension(raw)) return null;
  const { rows } = await query(
    `update extension_tokens set last_used_at = now()
      where token_hash = $1 and revoked_at is null and expires_at > now()
      returning user_id`,
    [hashToken(raw)],
  );
  return rows[0]?.user_id ?? null;
};

/** Revoca UN token (el que presenta la extensión al desconectarse). */
export const revocarTokenExtension = async (raw) => {
  if (!esTokenExtension(raw)) return;
  await query(
    `update extension_tokens set revoked_at = now() where token_hash = $1 and revoked_at is null`,
    [hashToken(raw)],
  );
};

/** Revoca TODOS los tokens vivos de un usuario (p. ej. al cerrar sesión en todo). */
export const revocarTodosLosTokensExtension = (userId) =>
  query(`update extension_tokens set revoked_at = now() where user_id = $1 and revoked_at is null`, [userId]);
