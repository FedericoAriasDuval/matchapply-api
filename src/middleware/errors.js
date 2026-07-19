/**
 * src/middleware/errors.js
 * El manejador global de errores. Le habla a una PERSONA, no a un log.
 *
 * LA FILOSOFIA, y no es un detalle cosmetico:
 * Quien busca trabajo lleva semanas de rechazos automaticos y de formularios que
 * se caen. Es, probablemente, la persona mas fragil que va a pasar por nuestra
 * web. Si le tiramos "Error 500: Internal Server Error", le decimos --en el peor
 * momento posible-- que tampoco aca lo tratan como a un ser humano.
 *
 * Por eso:
 *   1. Todo error se traduce a algo que una persona entiende.
 *   2. Todo error dice QUE HACER AHORA. Nunca lo dejamos en un callejon.
 *   3. Jamas se filtra un stack, ni el nombre de una tabla, ni una query.
 *   4. Cada error lleva un requestId corto: si nos escribe, sabemos que le paso
 *      sin obligarlo a explicarnos un error tecnico.
 *   5. Los 5xx se loguean completos de nuestro lado. El usuario ve empatia; la
 *      consola ve la verdad cruda.
 */
import crypto from 'node:crypto';
import { QueueFullError, TimeoutError } from '../lib/queue.js';

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const badRequest = (code, message, extra) => new HttpError(400, code, message, extra);
export const unauthorized = (code = 'unauthorized', message = 'Necesitas iniciar sesion.') =>
  new HttpError(401, code, message);
export const forbidden = (code, message, extra) => new HttpError(403, code, message, extra);
export const tooMany = (code, message, extra) => new HttpError(429, code, message, extra);

export const notFound = (_req, res) =>
  res.status(404).json({
    error: {
      code: 'not_found',
      message: 'Esa direccion no existe.',
      hint: 'Volve al inicio y proba de nuevo.',
    },
  });

/* El diccionario humano. `hint` es lo mas importante: es lo que el usuario puede
   HACER ahora mismo. Un error sin salida es una puerta cerrada. */
const HUMAN = {
  llm_disabled: {
    message: 'Estamos procesando tu CV con nuestro motor propio.',
    hint: 'El resultado igual es bueno: puede ser un poco menos fino, nada mas.',
    soft: true,
  },
  llm_unavailable: {
    message: 'Nuestro asistente de IA se tomo un respiro.',
    hint: 'Proba de nuevo en un minuto. Tu CV no se perdio: esta tal como lo dejaste.',
  },
  llm_timeout: {
    message: 'La IA esta tardando mas de lo normal.',
    hint: 'Volve a intentar. Si sigue lento, escribinos y lo miramos nosotros.',
  },
  llm_circuit_open: {
    message: 'El servicio de IA esta caido en este momento, y no es culpa tuya.',
    hint: 'Ya lo estamos mirando. Tu CV esta a salvo; volve en unos minutos.',
  },
  llm_bad_output: {
    message: 'Leimos tu CV, pero el resultado no nos convencio y preferimos no mostrartelo.',
    hint: 'Antes que darte algo mal hecho, preferimos pedirte que lo intentes otra vez.',
  },
  queue_full: {
    message: 'Hay mucha gente subiendo su CV en este momento.',
    hint: 'No es un error: es una fila. Volve en un rato y va a salir enseguida.',
  },
  cv_timeout: {
    message: 'Tu CV esta tardando demasiado en procesarse.',
    hint: 'Suele pasar con archivos escaneados o muy pesados. Proba con un PDF de texto.',
  },
  unsupported_file: {
    message: 'Ese archivo no parece un CV.',
    hint: 'Subi un PDF, un DOCX o un TXT. Si tu CV es una imagen escaneada, todavia no podemos leerlo.',
  },
  file_too_large: {
    message: 'El archivo supera los 8 MB.',
    hint: 'Casi siempre son las imagenes. Exportalo de nuevo como PDF y va a pesar mucho menos.',
  },
  invalid_credentials: {
    message: 'Email o contrasena incorrectos.',
    hint: 'Revisa el email, y fijate que no tengas las mayusculas activadas.',
  },
  db_unavailable: {
    message: 'No pudimos guardar tus datos en este momento.',
    hint: 'Tu CV sigue en pantalla: no cierres la ventana y proba de nuevo en unos segundos.',
  },
  internal_error: {
    message: 'Algo se rompio de nuestro lado.',
    hint: 'No es culpa tuya y no perdiste nada. Si vuelve a pasar, escribinos con este codigo.',
  },
};

/* Normaliza cualquier cosa lanzada a un HttpError con vocabulario humano. */
const normalize = (err) => {
  if (err instanceof QueueFullError) {
    return new HttpError(503, 'queue_full', 'Hay fila.', {
      waiting: err.waiting,
      etaSeconds: err.etaSeconds,
    });
  }
  if (err instanceof TimeoutError) return new HttpError(504, 'cv_timeout', 'Se agoto el tiempo.');
  if (err instanceof HttpError) return err;

  /* :id con formato inválido (uuid/int) → Postgres 22P02. Es un 404, no un 500. (Audit L3.) */
  if (err?.code === '22P02') {
    return new HttpError(404, 'not_found', 'No encontramos eso.');
  }
  /* Errores de Postgres (conexion, recursos, esquema): jamas salen hacia afuera. */
  if (err?.code && /^(08|53|57|3D)/.test(String(err.code))) {
    return new HttpError(503, 'db_unavailable', 'Base de datos no disponible.');
  }
  return new HttpError(500, 'internal_error', 'Error interno.');
};

// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, _next) => {
  const e = normalize(err);
  const requestId = crypto.randomBytes(4).toString('hex');

  if (e.status >= 500) {
    console.error(`[error:${requestId}]`, req.method, req.path, e.code, err?.stack || err);
  } else if (e.status === 429 || e.status === 403) {
    console.warn(`[warn:${requestId}]`, req.method, req.path, e.code);
  }

  const human = HUMAN[e.code] ?? HUMAN.internal_error;

  res.status(e.status).json({
    error: {
      code: e.code,
      message: human.message ?? (e.status < 500 ? e.message : HUMAN.internal_error.message),
      hint: human.hint,
      soft: human.soft ?? false,
      requestId,
      ...e.extra,
    },
  });
};

/**
 * Envoltorio para handlers async.
 * Sin esto, un `throw` dentro de un handler async NO llega al errorHandler de
 * Express 4: se pierde en una promesa rechazada y el request queda colgado hasta
 * el timeout del cliente. Es el bug mas silencioso de Express, y el que hace que
 * una app "ande bien" hasta que un dia deja de responder sin dejar un solo log.
 */
export const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
