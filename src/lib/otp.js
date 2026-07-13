/**
 * src/lib/otp.js
 * Ciclo de vida del código de verificación en base de datos:
 * emisión (invalidando los anteriores), consumo con límite de intentos y cooldown de reenvío.
 */
import { config } from '../config.js';
import { query } from '../db.js';
import { codeMatches, generateCode, hashCode } from './otpCore.js';

export { codeMatches, generateCode, hashCode } from './otpCore.js';

/** Emite un código nuevo e invalida los vivos. Devuelve el código en claro SOLO para el mail. */
export const issueCode = async (userId, purpose = 'signup') => {
  const code = generateCode();
  const expiresAt = new Date(Date.now() + config.auth.codeTtlMinutes * 60_000);

  await query(
    `update verification_codes set consumed_at = now()
      where user_id = $1 and purpose = $2 and consumed_at is null`,
    [userId, purpose],
  );
  await query(
    `insert into verification_codes (user_id, purpose, code_hash, expires_at, max_attempts)
     values ($1, $2, $3, $4, $5)`,
    [userId, purpose, hashCode(code), expiresAt, config.auth.codeMaxAttempts],
  );
  return { code, expiresAt };
};

/** @returns {{ok:true} | {ok:false, reason:'not_found'|'expired'|'too_many'|'wrong', left?:number}} */
export const consumeCode = async (userId, code, purpose = 'signup') => {
  const { rows } = await query(
    `select * from verification_codes
      where user_id = $1 and purpose = $2 and consumed_at is null
      order by created_at desc limit 1`,
    [userId, purpose],
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: 'not_found' };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, reason: 'expired' };
  if (row.attempts >= row.max_attempts) return { ok: false, reason: 'too_many' };

  if (!codeMatches(code, row.code_hash)) {
    const { rows: upd } = await query(
      `update verification_codes set attempts = attempts + 1 where id = $1
        returning attempts, max_attempts`,
      [row.id],
    );
    const left = Math.max(0, upd[0].max_attempts - upd[0].attempts);
    return { ok: false, reason: left === 0 ? 'too_many' : 'wrong', left };
  }

  await query(`update verification_codes set consumed_at = now() where id = $1`, [row.id]);
  return { ok: true };
};

/** Segundos que faltan para poder pedir otro código (0 = puede pedirlo). */
export const inResendCooldown = async (userId, purpose = 'signup') => {
  const { rows } = await query(
    `select created_at from verification_codes
      where user_id = $1 and purpose = $2
      order by created_at desc limit 1`,
    [userId, purpose],
  );
  if (!rows[0]) return 0;
  const elapsed = (Date.now() - new Date(rows[0].created_at).getTime()) / 1000;
  const left = Math.ceil(config.auth.resendCooldownSeconds - elapsed);
  return left > 0 ? left : 0;
};
