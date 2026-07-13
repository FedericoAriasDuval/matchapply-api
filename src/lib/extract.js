import mammoth from 'mammoth';
import { HttpError } from '../middleware/errors.js';

/**
 * Extrae texto plano de un CV subido (PDF o DOCX) y lo normaliza.
 * El texto extraído es la ÚNICA fuente de verdad que verá el modelo.
 */
export const extractText = async (file) => {
  if (!file?.buffer?.length) throw new HttpError(400, 'no_file', 'No recibimos ningún archivo.');
  const name = (file.originalname ?? '').toLowerCase();

  let text = '';
  if (name.endsWith('.pdf') || file.mimetype === 'application/pdf') {
    const { default: pdfParse } = await import('pdf-parse');
    const parsed = await pdfParse(file.buffer);
    text = parsed.text ?? '';
  } else if (name.endsWith('.docx') || name.endsWith('.doc')) {
    const { value } = await mammoth.extractRawText({ buffer: file.buffer });
    text = value ?? '';
  } else if (name.endsWith('.txt') || file.mimetype?.startsWith('text/')) {
    text = file.buffer.toString('utf8');
  } else {
    throw new HttpError(415, 'unsupported_file', 'Formato no soportado. Subí un PDF, DOCX o TXT.');
  }

  text = text.replace(/\r/g, '').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length < 40) {
    throw new HttpError(422, 'empty_cv', 'No pudimos leer texto del archivo. ¿Es un PDF escaneado?');
  }
  return text.slice(0, 60_000);
};
