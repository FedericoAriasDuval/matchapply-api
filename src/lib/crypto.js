/**
 * src/lib/crypto.js
 * Cifrado de los CVs en reposo. AES-256-GCM.
 *
 * POR QUÉ
 * En la web le prometemos a la persona: "Tu CV es tuyo. Nadie de nuestro equipo
 * lo lee." Hoy esa promesa depende de que nadie abra la base de datos. Eso no es
 * una garantía: es una intención. Con esto, el texto del CV queda ilegible
 * incluso para quien tenga acceso a Postgres — un dump de la base, un backup
 * filtrado o un empleado curioso ven bytes, no la vida laboral de nadie.
 *
 * Un CV es un documento denso en datos personales y, con frecuencia, en
 * categorías especiales del GDPR: salud, discapacidad, afiliación sindical, y
 * con foto, datos de los que se infiere origen racial. Cifrarlo no es
 * paranoia: es la línea de base.
 *
 * DECISIONES
 * - **AES-256-GCM**: cifrado autenticado. Si alguien altera un byte del texto
 *   cifrado, el descifrado FALLA en vez de devolver basura silenciosa.
 * - **IV aleatorio de 12 bytes por registro**: reusar el IV en GCM rompe el
 *   esquema por completo. Nunca se deriva del contenido.
 * - **Degradación honesta**: si no hay clave configurada, NO cifra y lo dice en
 *   el log de arranque. Prefiero un warning ruidoso a un cifrado falso que le
 *   dé a todo el mundo una sensación de seguridad que no existe.
 * - El sha256 del texto (source_hash) se calcula sobre el texto PLANO, antes de
 *   cifrar: es lo que permite deduplicar sin descifrar nada.
 */
import crypto from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // el tamaño recomendado para GCM
const PREFIX = 'v1'; // versionamos: el día que rotemos la clave, esto nos salva

/** La clave sale de CV_ENC_KEY: 32 bytes en hex (64 caracteres) o en base64. */
const loadKey = () => {
  const raw = process.env.CV_ENC_KEY;
  if (!raw) return null;
  let buf;
  if (/^[0-9a-f]{64}$/i.test(raw)) buf = Buffer.from(raw, 'hex');
  else buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error('CV_ENC_KEY debe ser de 32 bytes (64 hex o 44 base64). Generala con: openssl rand -hex 32');
  }
  return buf;
};

const KEY = loadKey();

/** true si el cifrado está activo de verdad. */
export const encryptionEnabled = () => KEY !== null;

/**
 * Cifra un texto. Formato: v1:<iv b64>:<tag b64>:<cipher b64>
 * Si no hay clave, devuelve el texto tal cual (y ya avisamos por consola).
 */
export const encryptText = (plain) => {
  if (!KEY) return String(plain ?? '');
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain ?? ''), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
};

/**
 * Descifra. Tolera texto plano heredado (lo de antes de activar el cifrado):
 * si no tiene nuestro prefijo, lo devuelve tal cual. Así la migración no rompe
 * los CVs que ya estaban guardados.
 */
export const decryptText = (payload) => {
  const s = String(payload ?? '');
  if (!s.startsWith(PREFIX + ':')) return s; // texto plano heredado
  if (!KEY) throw new Error('Hay datos cifrados pero falta CV_ENC_KEY.');

  const [, ivB64, tagB64, dataB64] = s.split(':');
  const decipher = crypto.createDecipheriv(ALGO, KEY, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
};

/** Cifra el JSON estructurado del CV (el que tiene los datos ya parseados). */
export const encryptJson = (obj) => encryptText(JSON.stringify(obj ?? null));

export const decryptJson = (payload) => {
  const txt = decryptText(payload);
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
};

/** Hash del texto PLANO: permite deduplicar sin descifrar. */
export const sha256 = (txt) => crypto.createHash('sha256').update(String(txt ?? '')).digest('hex');

/** Se llama al arrancar: el estado de la seguridad se dice en voz alta. */
export const announceEncryption = () => {
  if (KEY) {
    console.log('[crypto] CVs cifrados en reposo con AES-256-GCM.');
  } else {
    console.warn(
      '[crypto] ⚠️  CV_ENC_KEY no está configurada: los CVs se guardan EN TEXTO PLANO.\n' +
        '          Generá una con:  openssl rand -hex 32\n' +
        '          y cargala en Render como CV_ENC_KEY. La promesa de privacidad de la web\n' +
        '          depende de esto.',
    );
  }
};
