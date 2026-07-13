import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { config } from './config.js';
import { pool } from './db.js';
import { verifyMailer } from './lib/mailer.js';
import { errorHandler, notFound } from './middleware/errors.js';
import { authRouter } from './routes/auth.js';
import { billingRouter, billingWebhook } from './routes/billing.js';
import { cvRouter } from './routes/cv.js';

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

app.get('/health', async (_req, res) => {
  try {
    await pool.query('select 1');
    res.json({ ok: true, env: config.env, llm: config.llm.enabled, mail: config.mail.enabled });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.use('/auth', authRouter);
app.use('/cv', cvRouter);
app.use('/billing', billingRouter);

app.use(notFound);
app.use(errorHandler);

const server = app.listen(config.port, async () => {
  console.log(`MatchApply API escuchando en :${config.port} (${config.env})`);
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
