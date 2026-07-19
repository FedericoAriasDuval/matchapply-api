import mammoth from 'mammoth';
import { HttpError } from '../middleware/errors.js';

/**
 * Extrae texto plano de un CV subido (PDF, DOCX o TXT) y lo normaliza.
 * El texto extraído es la ÚNICA fuente de verdad que verá el modelo.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * POR QUÉ RECIBE EL TIPO EN VEZ DE MIRAR EL NOMBRE DEL ARCHIVO
 *
 * `validateUpload` ya detecta el tipo REAL leyendo los primeros bytes, que es
 * la única forma honesta de saber qué es un archivo. Antes acá se volvía a
 * decidir por la extensión del nombre, tirando a la basura esa detección. Eso
 * daba dos fallas, y la segunda es la peligrosa:
 *
 *   1. Un PDF de verdad llamado "cv" (sin extensión) se rechazaba con "formato
 *      no soportado", siendo un archivo perfectamente válido.
 *   2. Un PDF de verdad llamado "cv.txt" caía en la rama de texto y se hacía
 *      `buffer.toString('utf8')` sobre binario: salía un amasijo de símbolos
 *      con más de 40 caracteres, así que pasaba todos los controles y se le
 *      mandaba AL MODELO como si fuera un CV. El usuario recibía un diagnóstico
 *      inventado sobre basura, sin un solo error a la vista.
 *
 * Un error visible es malo; un resultado falso que parece bueno es peor.
 * ────────────────────────────────────────────────────────────────────────────
 */

/* Un CV no tiene 200 páginas. El tope frena que un libro subido por error se
   coma la CPU del proceso mientras otros esperan en la fila. */
const MAX_PAGINAS = 30;

const leerPdf = async (buffer) => {
  const { default: pdfParse } = await import('pdf-parse');
  let parsed;
  try {
    parsed = await pdfParse(buffer, { max: MAX_PAGINAS });
  } catch (e) {
    /* pdf-parse tira ante un PDF con contraseña o corrupto. Sin este catch el
       error subía crudo y salía un 500 "algo se rompió de nuestro lado", que es
       mentira: el problema lo tiene el archivo, y tiene arreglo. */
    if (/password|encrypt/i.test(String(e?.message ?? ''))) {
      throw new HttpError(422, 'pdf_locked', 'Ese PDF está protegido con contraseña.');
    }
    throw new HttpError(422, 'pdf_broken', 'No pudimos abrir ese PDF.');
  }
  return { texto: parsed.text ?? '', paginas: parsed.numpages ?? 0 };
};

/**
 * @param {object} file archivo de multer (con .buffer)
 * @param {'pdf'|'docx'|'doc'|'txt'} tipo el tipo REAL, el que devolvió validateUpload
 */
export const extractText = async (file, tipo) => {
  if (!file?.buffer?.length) throw new HttpError(400, 'no_file', 'No recibimos ningún archivo.');

  let text = '';
  let paginas = 0;

  if (tipo === 'pdf') {
    const r = await leerPdf(file.buffer);
    text = r.texto;
    paginas = r.paginas;
  } else if (tipo === 'docx' || tipo === 'doc') {
    try {
      const { value } = await mammoth.extractRawText({ buffer: file.buffer });
      text = value ?? '';
    } catch (e) {
      throw new HttpError(422, 'pdf_broken', 'No pudimos abrir ese documento.');
    }
  } else if (tipo === 'txt') {
    text = file.buffer.toString('utf8');
  } else {
    throw new HttpError(415, 'unsupported_file', 'Formato no soportado. Subí un PDF, DOCX o TXT.');
  }

  text = text.replace(/\r/g, '').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  if (text.length < 40) {
    /* Páginas sí, texto no: el PDF es una FOTO. Es un problema distinto de "el
       archivo vino vacío" y tiene una salida distinta, así que merece su propio
       código en vez de un "no pudimos leerlo" que no le dice a nadie qué hacer. */
    if (tipo === 'pdf' && paginas > 0) {
      throw new HttpError(422, 'pdf_scanned', 'Ese PDF es una imagen escaneada: no tiene texto.');
    }
    throw new HttpError(422, 'empty_cv', 'No pudimos leer texto del archivo.');
  }

  return text.slice(0, 60_000);
};
