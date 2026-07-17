import 'dotenv/config';

const required = (key, fallback = undefined) => {
  const v = process.env[key] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Falta la variable de entorno: ${key}`);
  return v;
};

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  isProd: (process.env.NODE_ENV ?? 'development') === 'production',
  port: Number(process.env.PORT ?? 8080),
  appUrl: process.env.APP_URL ?? 'http://localhost:5173',
  // La URL publica de ESTA API. OAuth la usa para armar el redirect_uri, y tiene
  // que ser identica a la que cargues en Google/LinkedIn: si difiere en un
  // caracter, el proveedor rechaza el login.
  apiUrl: process.env.API_URL ?? 'https://api.mavante.com',

  db: {
    url: required('DATABASE_URL'),
    ssl: String(process.env.PGSSL ?? 'false') === 'true' ? { rejectUnauthorized: false } : false,
  },

  auth: {
    jwtSecret: required('JWT_SECRET'),
    accessTtl: process.env.ACCESS_TTL ?? '15m',
    refreshTtlDays: Number(process.env.REFRESH_TTL_DAYS ?? 30),
    bcryptRounds: 12,
    cookieDomain: process.env.COOKIE_DOMAIN || undefined,
    // MFA
    codeTtlMinutes: 15,
    codeMaxAttempts: 5,
    resendCooldownSeconds: 30,
    // bloqueo por fuerza bruta
    maxFailedLogins: 8,
    lockoutMinutes: 15,
  },

  mail: {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 465),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    /* support@, no no-reply@. Con cero usuarios cada respuesta es oro: si
       alguien contesta "no me llego el codigo", tiene que llegarnos. Y nuestra
       propia pagina dice "del otro lado hay una persona, no un ticket" — un
       no-reply@ es, literalmente, un ticket. */
    from: process.env.MAIL_FROM ?? 'Mavante <support@mavante.com>',
    enabled: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
  },

  llm: {
    /* Proveedor activo. 'anthropic' (default, lo que corre hoy) | 'gemini'.
       Para pasar a Gemini: setear LLM_PROVIDER=gemini + GEMINI_API_KEY en el env.
       Nada cambia hasta hacer ese flip — Claude sigue siendo el default. */
    provider: (process.env.LLM_PROVIDER ?? 'anthropic').toLowerCase(),
    // Anthropic (Claude)
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.LLM_MODEL ?? 'claude-sonnet-5',
    // Google Gemini
    geminiKey: process.env.GEMINI_API_KEY,
    geminiModel: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',   // Flash: barato, para abaratar costos
    maxTokens: 4000,
    enabled: (process.env.LLM_PROVIDER ?? 'anthropic').toLowerCase() === 'gemini'
      ? Boolean(process.env.GEMINI_API_KEY)
      : Boolean(process.env.ANTHROPIC_API_KEY),
  },

  billing: {
    stripeKey: process.env.STRIPE_SECRET_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    pricePro: process.env.STRIPE_PRICE_PRO,
    enabled: Boolean(process.env.STRIPE_SECRET_KEY),
  },

  quota: { free: 5, pro: 30 },
};
