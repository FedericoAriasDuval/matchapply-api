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

/** Emite un token para `userId`, lo guarda HASHEADO y devuelve el token EN CLARO
 *  (única vez que se puede ver) + su vencimiento. */
export const crearTokenExtension = async (userId, label = null, ttlDays = EXT_TTL_DAYS) => {
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
