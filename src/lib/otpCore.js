/**
 * src/lib/otpCore.js
 * Generación y verificación del código de 6 dígitos — módulo puro (sin DB).
 *   · CSPRNG con rejection sampling: sin sesgo de módulo.
 *   · Se persiste el HMAC-SHA256, nunca el código.
 *   · Comparación en tiempo constante.
 */
import crypto from 'node:crypto';

const pepper = () => process.env.JWT_SECRET ?? 'dev-pepper';

export const generateCode = () => {
  const max = 1_000_000;
  const limit = Math.floor(0xffffffff / max) * max;
  let n;
  do {
    n = crypto.randomBytes(4).readUInt32BE(0);
  } while (n >= limit);
  return String(n % max).padStart(6, '0');
};

export const hashCode = (code) =>
  crypto.createHmac('sha256', pepper()).update(String(code)).digest('hex');

export const codeMatches = (code, storedHash) => {
  const a = Buffer.from(hashCode(code));
  const b = Buffer.from(String(storedHash ?? ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
