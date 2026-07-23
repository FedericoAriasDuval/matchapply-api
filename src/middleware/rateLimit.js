/**
 * src/middleware/rateLimit.js
 * Los frenos. Y, sobre todo, a QUIÉN se los ponemos.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * EL PROBLEMA QUE SE ARREGLÓ ACÁ (19/07/2026, un día antes del lanzamiento)
 *
 * Todos los límites se contaban POR IP. En Argentina eso no significa "por
 * persona": significa "por operador". Los celulares de Claro, Personal y
 * Movistar salen a internet por CGNAT — miles de usuarios compartiendo un
 * puñado de direcciones. Lo mismo pasa en una oficina o en el wifi de una
 * facultad, donde todos comparten una sola IP.
 *
 * Con "5 registros por IP cada 15 minutos", el escenario del lanzamiento era:
 * se postea, la nota funciona, y a partir de la sexta persona que entra desde
 * datos móviles TODAS ven "Demasiados intentos". El freno se activaba justo en
 * el pico, se veía como un producto roto, y en las métricas iba a parecer que
 * la gente no se registraba porque no le interesaba.
 *
 * LA REGLA NUEVA, en dos partes:
 *
 *   1. Si sabemos QUIÉN es (ya inició sesión), el freno se cuenta por USUARIO.
 *      Ahí la IP compartida deja de importar por completo.
 *   2. Si todavía no sabemos quién es (registro, login, código), no queda otra
 *      que contar por IP — pero con números pensados para una IP compartida por
 *      cientos de personas, no por una.
 *
 * Subir estos números NO nos deja sin defensa, porque la defensa de verdad
 * contra el ataque real (probar contraseñas) es POR CUENTA y ya existe:
 *   · 8 intentos fallidos bloquean ESA cuenta 15 minutos (config.auth).
 *   · un código de verificación admite 5 intentos y después se quema.
 *   · reenviar un código tiene 30 s de espera POR USUARIO.
 * Ninguna de esas tres se esquiva cambiando de IP, que es exactamente lo que un
 * atacante hace y un usuario legítimo no.
 * ────────────────────────────────────────────────────────────────────────────
 */
import rateLimit from 'express-rate-limit';

/* Una IPv6 completa identifica un dispositivo, así que rotando el último tramo
   se esquiva el freno. Se agrupa por bloque /64, que es lo que de verdad le
   asignan a una conexión. */
const claveIp = (req) => {
  const ip = req.ip ?? '';
  if (ip.includes(':')) return `${ip.split(':').slice(0, 4).join(':')}::/64`;
  return ip;
};

/* Con sesión, el freno es tuyo y no de tu operador. */
const porUsuarioOIp = (req) => (req.user?.id ? `u:${req.user.id}` : `ip:${claveIp(req)}`);

const opts = (windowMs, max, code, hint, keyGenerator) => ({
  windowMs,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyGenerator ?? claveIp,
  /* Mismo sobre que el resto de los errores ({error:{...}}), con la salida
     concreta y cuántos segundos faltan: "esperá unos minutos" no le sirve a
     alguien que no sabe cuántos. */
  handler: (_req, res) => {
    res.status(429).json({
      error: {
        code,
        message: 'Probaste muchas veces seguidas.',
        hint,
        retryAfterSeconds: Math.max(1, Math.ceil(windowMs / 1000)),
      },
    });
  },
});

/** Registro: 25 altas por IP cada 15 min (una IP = un operador entero, no una persona). */
export const signupLimiter = rateLimit(
  opts(15 * 60_000, 25, 'signup_rate_limited',
    'Esperá unos minutos y volvé a intentarlo. Si ya creaste la cuenta, entrá con tu email.'),
);

/** Login: 40 intentos por IP cada 10 min. El freno real es por cuenta: 8 fallidos la bloquean. */
export const loginLimiter = rateLimit(
  opts(10 * 60_000, 40, 'login_rate_limited',
    'Esperá unos minutos. Si no te acordás la contraseña, podés entrar con Google.'),
);

/** Verificación / reenvío: 40 por IP cada 10 min. Cada código ya admite 5 intentos y muere. */
export const codeLimiter = rateLimit(
  opts(10 * 60_000, 40, 'code_rate_limited',
    'Esperá un momento y pedí un código nuevo. Revisá también el correo no deseado.'),
);

/**
 * Endpoints de IA: 30 cada 5 minutos POR USUARIO (no por IP).
 * Todos exigen sesión ANTES de este freno, así que siempre sabemos quién es.
 * El límite de verdad sigue siendo la cuota diaria (3 free / 30 pro); esto solo
 * evita que alguien se dispare toda su cuota en diez segundos.
 */
export const aiLimiter = rateLimit(
  opts(5 * 60_000, 30, 'ai_rate_limited',
    'Fue todo muy rápido. Esperá un minuto: tu CV está guardado.', porUsuarioOIp),
);

/* Reseñas: 15 cada 10 min. Pueden ser anónimas, así que el freno es por IP —
   pero 5 era muy poco para una oficina entera. */
export const reviewLimiter = rateLimit(
  opts(10 * 60_000, 15, 'review_rate_limited',
    'Ya recibimos tu comentario. Si querés corregirlo, probá en unos minutos.'),
);

/* Llave de fundador: 20 intentos por IP cada 15 min. El token es largo y
   aleatorio; esto solo le saca al brute-force la fuerza bruta. (Audit L4.) */
export const adminLimiter = rateLimit(
  opts(15 * 60_000, 20, 'admin_rate_limited', 'Esperá unos minutos.'),
);

/* Panel de empresas: 120 cada 5 min POR CLAVE (no por IP): varias personas
   de la misma empresa salen por la misma oficina, y contarlas juntas dejaria a
   media empresa afuera. Sin clave todavia, cae a la IP. */
export const corporateLimiter = rateLimit(
  opts(5 * 60_000, 120, 'corporate_rate_limited', 'Esperá un momento y volvé a intentarlo.',
    (req) => {
      const k = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
      return k ? 'co:' + k.slice(0, 24) : 'ip:' + claveIp(req);
    }),
);

/* Canje de licencia institucional: 12 intentos cada 15 min POR USUARIO. Exige
   sesión, así que siempre sabemos quién prueba — y un código de licencia es lo
   único adivinable del sistema. Doce alcanza de sobra para alguien que lo copió
   mal de un mail; no alcanza para barrer el espacio de códigos. */
export const licenseLimiter = rateLimit(
  opts(15 * 60_000, 12, 'license_rate_limited',
    'Probaste varias veces. Esperá unos minutos y fijate que el código esté completo.', porUsuarioOIp),
);

/* Webhooks de pago: 60/min por IP. MP/Paddle mandan poco; frena la amplificación
   de fetch salientes con ids arbitrarios hacia la API del proveedor. (Audit M7.) */
export const webhookLimiter = rateLimit(
  opts(60_000, 60, 'webhook_rate_limited', 'Reintentá en un minuto.'),
);
