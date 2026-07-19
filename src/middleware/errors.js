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

  /* ── Los 4xx que una persona real toca todos los dias. ──────────────────────
     Antes caian en el fallback y le decian "algo se rompio de nuestro lado" a
     alguien que solo tenia que iniciar sesion. Un error que se echa la culpa
     equivocada es peor que uno tecnico: manda a la persona a esperar en vez de
     a hacer lo unico que la destraba. */
  unauthorized: {
    message: 'Necesitas iniciar sesion para hacer esto.',
    hint: 'Toca "Iniciar sesion" arriba a la derecha. Tu CV sigue en pantalla.',
  },
  session_expired: {
    message: 'Tu sesion se cerro por seguridad.',
    hint: 'Volve a entrar con tu email. No perdiste nada de lo que escribiste.',
  },
  not_verified: {
    message: 'Todavia falta verificar tu email.',
    hint: 'Te mandamos un codigo cuando te registraste. Revisa tambien el correo no deseado.',
  },
  pro_required: {
    message: 'Esta funcion es parte de Mavante Pro.',
    hint: 'El diagnostico y el CV estructurado siguen siendo gratis. Podes activar Pro desde tu cuenta.',
  },
  quota_exceeded: {
    message: 'Llegaste a tu limite de analisis por hoy.',
    hint: 'Se renueva manana. Lo que ya generaste queda guardado.',
  },
  mail_failed: {
    message: 'No pudimos mandarte el codigo por mail.',
    hint: 'Tu cuenta quedo creada. Toca "Reenviar codigo" en un minuto, o escribinos a support@mavante.com.',
  },
  invalid_code: {
    message: 'Ese codigo no es correcto, o ya vencio.',
    hint: 'Pedi uno nuevo desde la misma pantalla y usa el ultimo que te llegue.',
  },
  resend_cooldown: {
    message: 'Recien te mandamos un codigo.',
    hint: 'Espera unos segundos antes de pedir otro; a veces el mail tarda en llegar.',
  },
  account_locked: {
    message: 'Bloqueamos la cuenta un rato por intentos fallidos.',
    hint: 'Es para protegerte. Proba de nuevo en unos minutos, o entra con Google.',
  },
  weak_password: {
    message: 'Esa contrasena es facil de adivinar.',
    hint: 'Usa al menos 8 caracteres y mezcla letras con numeros.',
  },
  password_mismatch: {
    message: 'Las dos contrasenas no coinciden.',
    hint: 'Escribilas de nuevo con cuidado.',
  },
  user_not_found: {
    message: 'No encontramos una cuenta con ese email.',
    hint: 'Fijate si lo escribiste bien, o crea una cuenta nueva.',
  },
  already_verified: {
    message: 'Esa cuenta ya estaba verificada.',
    hint: 'Podes iniciar sesion directamente.',
  },
  token_invalid: {
    message: 'Ese enlace ya no sirve.',
    hint: 'Los enlaces vencen por seguridad. Pedi uno nuevo desde la pantalla de ingreso.',
  },
  cv_not_found: {
    message: 'No encontramos ese CV.',
    hint: 'Puede que lo hayas borrado. Volve a Herramientas y subilo de nuevo.',
  },
  empty_cv: {
    message: 'El CV llego vacio.',
    hint: 'Pega el texto en el recuadro, o subi el archivo otra vez.',
  },
  no_file: {
    message: 'No llego ningun archivo.',
    hint: 'Elegi el archivo de nuevo y fijate que la subida termine.',
  },
  invalid_cv: {
    message: 'Eso no parece un CV.',
    hint: 'Necesitamos tu experiencia en texto: puesto, empresa y que hiciste.',
  },
  cv_unparsable: {
    message: 'No pudimos leer el contenido de ese archivo.',
    hint: 'Suele pasar con PDFs escaneados. Proba con uno exportado desde Word o Docs.',
  },
  invalid_payload: {
    message: 'Algunos datos llegaron incompletos.',
    hint: 'Revisa el formulario y proba de nuevo. Si estas con poca senal, puede que se haya cortado el envio.',
  },
  payload_too_large: {
    message: 'El texto que pegaste es demasiado largo.',
    hint: 'Deja solo tu CV: si pegaste ademas la descripcion del puesto, va en el campo de al lado.',
  },
  bad_format: {
    message: 'Ese formato no esta disponible.',
    hint: 'Elegi uno de los formatos que ofrece el boton de descarga.',
  },
  interview_session: {
    message: 'Se corto el hilo de la entrevista.',
    hint: 'Empeza una entrevista nueva: las respuestas que diste quedan en el transcript.',
  },
  cover_failed: {
    message: 'No nos salio una carta que valiera la pena.',
    hint: 'Antes que darte un texto generico, preferimos que lo intentes otra vez.',
  },
  billing_disabled: {
    message: 'Los pagos no estan disponibles en este momento.',
    hint: 'Escribinos a support@mavante.com y lo resolvemos con vos.',
  },
  billing_no_url: {
    message: 'No pudimos abrir la pantalla de pago.',
    hint: 'Proba de nuevo en un minuto. No se te cobro nada.',
  },
  oauth_disabled: {
    message: 'El ingreso con Google no esta disponible ahora.',
    hint: 'Podes entrar con tu email y contrasena.',
  },
  admin_only: {
    message: 'Esa direccion no existe.',
    hint: 'Volve al inicio y proba de nuevo.',
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

  /* El pedido llegó cortado o mal armado. Lo tira body-parser ANTES de que
     ninguna ruta lo vea, así que ningún try/catch nuestro lo agarra y caía en
     internal_error: le decíamos "se rompió algo de nuestro lado" a alguien cuyo
     celular perdió señal a mitad del envío. Además ensuciaba el log con 500
     falsos, que el día del lanzamiento tapan los 500 de verdad. */
  if (err?.type === 'entity.parse.failed') {
    return new HttpError(400, 'invalid_payload', 'Los datos llegaron incompletos.');
  }
  /* OJO: esto NO es el límite de los archivos (8 MB, lo valida upload.js). Es el
     del cuerpo JSON: se llega pegando un texto enorme, no subiendo un PDF. Usar
     acá la copy de "el archivo supera los 8 MB" le habla de un archivo a alguien
     que no subió ninguno. */
  if (err?.type === 'entity.too.large') {
    return new HttpError(413, 'payload_too_large', 'El texto que pegaste es demasiado largo.');
  }

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

  /* El fallback NUNCA es internal_error para un 4xx: un codigo nuevo que todavia
     no tiene copy igual trae su propio mensaje humano desde donde se lanzo, y
     echarle la culpa al servidor manda a la persona a esperar en vez de a
     arreglar lo unico que la destraba. Solo el 5xx es culpa nuestra. */
  const human = HUMAN[e.code] ?? (e.status < 500 ? { message: e.message } : HUMAN.internal_error);

  res.status(e.status).json({
    error: {
      code: e.code,
      message: human.message || HUMAN.internal_error.message,
      hint: human.hint ?? (e.status < 500 ? 'Corregilo y proba de nuevo.' : HUMAN.internal_error.hint),
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
