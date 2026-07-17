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
    /* Modelo FIJO y GA. Descartados en el camino (16-17/07):
         - gemini-2.5-flash  -> 404 "no longer available to new users" (cuenta nueva).
         - gemini-flash-latest (alias) -> 503 "high demand" persistente: el alias
           apunta a un modelo bajo carga, sin capacidad dedicada.
       gemini-2.0-flash es GA, mas barato todavia y con capacidad estable (casi no
       tira 503). Es extraccion de campos, no necesita razonar. Se puede fijar con
       GEMINI_MODEL en el env si algun dia conviene otro. */
    geminiModel: process.env.GEMINI_MODEL ?? 'gemini-2.0-flash',
    maxTokens: 4000,
    enabled: (process.env.LLM_PROVIDER ?? 'anthropic').toLowerCase() === 'gemini'
      ? Boolean(process.env.GEMINI_API_KEY)
      : Boolean(process.env.ANTHROPIC_API_KEY),
  },

  billing: {
    /* VARIOS métodos pueden coexistir: el usuario elige en el checkout.
       Cada método se prende solo si tiene sus credenciales. El plan Pro lo
       activa SIEMPRE el webhook del proveedor tras cobrar — nunca un clic.
       (BILLING_PROVIDER queda de legado; ya no gatea nada.) */
    provider: (process.env.BILLING_PROVIDER ?? 'stripe').toLowerCase(),
    // Stripe (legado, no opera en Argentina)
    stripeKey: process.env.STRIPE_SECRET_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    pricePro: process.env.STRIPE_PRICE_PRO,
    // Paddle — internacional, USD (Merchant of Record)
    paddleApiKey: process.env.PADDLE_API_KEY,
    paddleWebhookSecret: process.env.PADDLE_WEBHOOK_SECRET,
    paddlePriceId: process.env.PADDLE_PRICE_ID,
    paddleCheckoutUrl: process.env.PADDLE_CHECKOUT_URL,
    paddleEnv: (process.env.PADDLE_ENV ?? 'sandbox').toLowerCase(),
    paddleEnabled: Boolean(process.env.PADDLE_API_KEY && process.env.PADDLE_WEBHOOK_SECRET && process.env.PADDLE_PRICE_ID),
    // Mercado Pago — Argentina, ARS. Access token del panel de MP + precio en pesos.
    mpAccessToken: process.env.MP_ACCESS_TOKEN,
    mpPriceArs: Number(process.env.MP_PRICE_ARS ?? 0),
    mpEnabled: Boolean(process.env.MP_ACCESS_TOKEN && Number(process.env.MP_PRICE_ARS ?? 0) > 0),
    // ¿hay ALGÚN método disponible? (lo usa el front para saber si mostrar el botón)
    enabled: Boolean(
      (process.env.PADDLE_API_KEY && process.env.PADDLE_WEBHOOK_SECRET && process.env.PADDLE_PRICE_ID) ||
      (process.env.MP_ACCESS_TOKEN && Number(process.env.MP_PRICE_ARS ?? 0) > 0) ||
      process.env.STRIPE_SECRET_KEY,
    ),
  },

  quota: { free: 3, pro: 30 },
};
