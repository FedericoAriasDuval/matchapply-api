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
import { llmHealth } from './lib/llm.js';
import { cvCache } from './lib/cache.js';
import { authRouter } from './routes/auth.js';
import { billingRouter, billingWebhook } from './routes/billing.js';
import { cvRouter } from './routes/cv.js';
import { reviewsRouter } from './routes/reviews.js';
import { statsRouter } from './routes/stats.js';
import { featuredRouter } from './routes/featured.js';
import { referralsRouter } from './routes/referrals.js';
import { oauthRouter } from './routes/oauth.js';

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
      mail: config.mail.enabled,
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
  res.status(saturated ? 503 : 200).json({ ready: !saturated, queue: q });
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

app.use(notFound);
app.use(errorHandler);

const server = app.listen(config.port, async () => {
  console.log(`MatchApply API escuchando en :${config.port} (${config.env})`);
  announceEncryption();   // el estado de la privacidad se dice en voz alta al arrancar
  if (config.mail.enabled) await verifyMailer();
  else console.warn('[mailer] SMTP sin configurar: los códigos se imprimen por consola (solo dev).');
  if (!config.llm.enabled) console.warn('[llm] ANTHROPIC_API_KEY sin configurar: /cv/parse va a responder 503.');
});

const shutdown = async (signal) => {
  console.log(`\n${signal} recibido, cerrando...`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export { app };
