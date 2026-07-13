/**
 * src/lib/json.js
 * Extracción robusta del primer objeto JSON balanceado de una respuesta del modelo.
 * Módulo puro: tolera markdown, texto alrededor y llaves dentro de strings.
 */
export class JsonExtractError extends Error {}

export const extractJson = (text) => {
  const raw = String(text ?? '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '');
  const start = raw.indexOf('{');
  if (start < 0) throw new JsonExtractError('El modelo no devolvió JSON.');

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(start, i + 1));
        } catch {
          throw new JsonExtractError('El modelo devolvió un JSON inválido.');
        }
      }
    }
  }
  throw new JsonExtractError('El modelo devolvió un JSON incompleto.');
};
