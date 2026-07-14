// =====================================================================
// El código de invitación.
//
// Vive acá y no en routes/referrals.js por una razón práctica: es una función
// pura, y una función pura no tiene por qué arrastrar Express y un pool de
// Postgres para poder testearse. Si para probar que un código tiene 7 letras
// hay que levantar una base de datos, el código está en el lugar equivocado.
// =====================================================================
import crypto from 'node:crypto';

/** Sin 0/O ni 1/I/L. La gente dicta estos códigos por teléfono y los escribe
 *  a mano: un carácter ambiguo es un ticket de soporte. */
export const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const CODE_LEN = 7;

/**
 * Código aleatorio de 7 caracteres → 31^7 ≈ 2.7e10 combinaciones.
 *
 * Aleatorio a propósito: derivarlo del id o del email haría que un link
 * público —que es exactamente lo que es— filtre datos de quien lo comparte.
 *
 * Sobre el `% ALPHABET.length`: introduce un sesgo módulo, porque 256 no es
 * múltiplo de 31. El sesgo real es de ~0,4% sobre los primeros 8 caracteres.
 * Para un código de invitación es irrelevante y lo dejo así a conciencia; si
 * esto fuera un token de seguridad, habría que usar rechazo por muestreo.
 */
export const newCode = () => {
  const bytes = crypto.randomBytes(CODE_LEN);
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
};

/** ¿Tiene forma de código? No dice si existe: dice si vale la pena preguntarle
 *  a la base. Ahorra una consulta por cada link mal pegado. */
export const looksLikeCode = (raw) => /^[A-Z0-9]{7}$/.test(String(raw || '').trim().toUpperCase());
