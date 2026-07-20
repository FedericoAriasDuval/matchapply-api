import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { config } from './config.js';
import { pool } from './db.js';
import { verifyMailer } from './lib/mailer.js';
import { errorHandler, notFound } from './middleware/errors.js';
import { announceEncryption, encryptionEnabled } from './lib/crypto.js';
import { cvQueue } from './lib/queue.js';
import { cerrarOrdenado } from './lib/shutdown.js';
import { llmHealth } from './lib/llm.js';
import { cvCache } from './lib/cache.js';
import { authRouter } from './routes/auth.js';
import { billingRouter, billingWebhook, availableMethods, lifetimeAvailable } from './routes/billing.js';
import { adminRouter } from './routes/admin.js';
import { cvRouter } from './routes/cv.js';
import { reviewsRouter } from './routes/reviews.js';
import { statsRouter } from './routes/stats.js';
import { featuredRouter } from './routes/featured.js';
import { referralsRouter } from './routes/referrals.js';
import { oauthRouter } from './routes/oauth.js';
import { corporateRouter } from './routes/corporate.js';
import { talentRouter } from './routes/talent.js';

const app = express();
app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: false, // el frontend es estático y vive en otro origen
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }),
);
app.use(
  cors({
    origin: config.appUrl,
    credentials: true,           // cookies httpOnly de sesión
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  }),
);

// El webhook necesita el body crudo: se monta ANTES del parser de JSON.
app.post('/billing/webhook', ...billingWebhook);

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

/*
 * /health es lo que mirás el viernes a las 9 PM cuando entra el pico.
 * No alcanza con "ok:true": necesitás ver la FILA, el BREAKER y la CACHÉ, que son
 * las tres cosas que se rompen bajo carga. Sin esto volás a ciegas.
 */
app.get('/health', async (_req, res) => {
  try {
    await pool.query('select 1');
    res.json({
      ok: true,
      env: config.env,
      llm: config.llm.enabled,
      llmProvider: llmHealth().provider,   // qué motor está activo: anthropic | gemini
      llmModel: llmHealth().model,         // y qué modelo, para verlo de un vistazo
      mail: config.mail.enabled,
      billing: config.billing.enabled,   // ¿los pagos están activos? el front no dibuja un botón que miente
      billingMethods: availableMethods(),// qué métodos ofrecer: ['mercadopago','paddle']
      lifetime: lifetimeAvailable(),     // ¿se puede vender el pago único? el front no dibuja lo que no se puede comprar
      encrypted: encryptionEnabled(),
      queue: cvQueue.snapshot(),
      breaker: llmHealth().breaker,
      cache: cvCache.stats,
      uptimeSec: Math.round(process.uptime()),
      memMB: Math.round(process.memoryUsage().rss / 1048576),
    });
  } catch {
    res.status(503).json({ ok: false, hint: 'La base de datos no responde.' });
  }
});

/* Readiness separado de liveness: si la fila está desbordada, seguimos VIVOS
   pero no queremos más tráfico. Es la señal que un balanceador necesita. */
app.get('/ready', (_req, res) => {
  const q = cvQueue.snapshot();
  const saturated = q.waiting >= cvQueue.maxQueue * 0.9;
  /* Durante un deploy tampoco estamos listos: seguimos vivos terminando lo que
     quedó, pero no queremos tráfico nuevo. */
  const ready = !saturated && !cvQueue.closing;
  res.status(ready ? 200 : 503).json({ ready, closing: cvQueue.closing, queue: q });
});

app.use('/auth', authRouter);
/* DESPUES de authRouter, y es importante: /auth/:provider es un comodin y se
   comeria /auth/login, /auth/verify y /auth/resend si fuera primero. */
app.use('/auth', oauthRouter);
app.use('/cv', cvRouter);
app.use('/reviews', reviewsRouter);   // POST publico · GET /summary solo con ADMIN_TOKEN
app.use('/reviews', featuredRouter);  // GET /reviews/featured: solo testimonios REALES
app.use('/stats', statsRouter);       // numeros propios, sin inflar
app.use('/referrals', referralsRouter);// el credito se paga al verificar, no al hacer clic
app.use('/billing', billingRouter);
app.use('/admin', adminRouter);        // llave de fundador (ADMIN_TOKEN): comp-ear Pro hasta que haya pagos
/* Panel de Talento. /talent es del USUARIO (su sesion); /corporate es de la
   EMPRESA (su clave). Namespaces separados a proposito: dos puertas distintas
   para dos mundos distintos, sin cruce posible. /corporate ademas devuelve 404
   entero mientras TALENT_PANEL_ENABLED no este en true. */
app.use('/talent', talentRouter);
app.use('/corporate', corporateRouter);

app.use(notFound);
app.use(errorHandler);

const server = app.listen(config.port, async () => {
  console.log(`Mavante API escuchando en :${config.port} (${config.env})`);
  announceEncryption();   // el estado de la privacidad se dice en voz alta al arrancar
  if (config.mail.enabled) await verifyMailer();
  else console.warn('[mailer] SMTP sin configurar: los códigos se imprimen por consola (solo dev).');
  if (!config.llm.enabled) console.warn('[llm] ANTHROPIC_API_KEY sin configurar: /cv/parse va a responder 503.');
});

/*
 * RED DE SEGURIDAD DEL PROCESO.
 *
 * Node mata el proceso ante una promesa rechazada que nadie atrapó. Un solo
 * `.catch` que falta en cualquier rincón —un webhook raro, un mail que revienta,
 * un await olvidado— y la API entera se cae para TODOS. Render la reinicia, pero
 * son 30-60 segundos de sitio muerto, y el día del lanzamiento eso es la
 * diferencia entre "andaba lento" y "no andaba".
 *
 * La distinción importa:
 *   - unhandledRejection: casi siempre es un pedido puntual que salió mal. Se
 *     loguea con el detalle completo y se SIGUE sirviendo. Matar a los otros 200
 *     usuarios por el error de uno es la peor decisión posible.
 *   - uncaughtException: el proceso ya quedó en un estado que no entendemos.
 *     Ahí sí se cierra ordenado (drenando lo que estaba corriendo) y se deja que
 *     Render levante uno limpio. Seguir sirviendo desde un estado corrupto es
 *     peor que un reinicio.
 */
process.on('unhandledRejection', (reason) => {
  console.error('[fatal:rejection] promesa sin catch — la API SIGUE viva:', reason?.stack || reason);
});

let cerrando = false;

const shutdown = async (signal, code = 0) => {
  if (cerrando) return;          // SIGTERM dos veces no puede duplicar el cierre
  cerrando = true;
  console.log(`\n${signal} recibido, cerrando...`);

  await cerrarOrdenado({ server, queue: cvQueue, pool, drainMs: 25_000 });
  process.exit(code);
};

process.on('uncaughtException', (err) => {
  console.error('[fatal:exception] estado desconocido, reiniciamos:', err?.stack || err);
  shutdown('uncaughtException', 1);
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/* Render corta a los ~30 s del SIGTERM; si el drenaje se pasa, salimos igual
   antes de que nos maten de afuera (un SIGKILL no cierra el pool). */
process.on('exit', () => { if (!cerrando) console.log('[shutdown] salida sin senal'); });

export { app };
