/**
 * src/lib/llm.js
 * Cliente del modelo.
 *
 * OJO (16/07/2026): claude-sonnet-5 rechaza con 400 tanto `temperature` como el
 * prefill de asistente. Por eso aca no se manda ninguno de los dos. El JSON se
 * garantiza por prompt (cvPrompt exige JSON puro) + extractJson + sanitizeCv.
 *
 * BLINDAJE PARA EL LANZAMIENTO
 *   - timeout duro con AbortController: una llamada colgada es un slot muerto.
 *   - reintento con backoff exponencial + jitter, solo en errores transitorios.
 *   - circuit breaker: si el proveedor se cayo, fallamos RAPIDO en vez de hacer
 *     esperar 30 segundos a cada uno de los que estan en la fila.
 *   - fallback opcional al motor local: la app degrada, no se rompe.
 *
 * La regla que gobierna este archivo: un error del proveedor de IA nunca puede
 * convertirse en un error del usuario.
 */
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';
import { HttpError } from '../middleware/errors.js';
import { JsonExtractError, extractJson } from './json.js';
import { llmBreaker } from './breaker.js';

export { extractJson } from './json.js';

const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 30000);
const MAX_RETRIES = 2;

/* Dos proveedores, un solo cliente. El flag LLM_PROVIDER decide cuál se usa;
   todo el blindaje de abajo (timeout, reintentos, breaker, fallback) es igual
   para los dos. Cambiar de proveedor NO toca ninguna otra parte del sistema. */
const PROVIDER = config.llm.provider === 'gemini' ? 'gemini' : 'anthropic';

const anthropic = (PROVIDER === 'anthropic' && config.llm.enabled)
  ? new Anthropic({ apiKey: config.llm.apiKey, maxRetries: 0 })
  : null;
const gemini = (PROVIDER === 'gemini' && config.llm.enabled)
  ? new GoogleGenAI({ apiKey: config.llm.geminiKey })
  : null;

const hasClient = () => (PROVIDER === 'gemini' ? !!gemini : !!anthropic);
const activeModel = () => (PROVIDER === 'gemini' ? config.llm.geminiModel : config.llm.model);

/* 429 y 5xx son transitorios: reintentar sirve. Un 400 es culpa nuestra: no. */
const isTransient = (e) => {
  const s = e?.status ?? e?.response?.status;
  return s === 429 || (s >= 500 && s < 600) || e?.name === 'AbortError' || e?.code === 'ECONNRESET';
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Backoff exponencial CON jitter. Sin el jitter, todos los reintentos caen en el
   mismo milisegundo y le pegan al proveedor con un pico sincronizado (thundering
   herd): una caida corta se convierte en una caida larga. */
const backoff = (attempt) => 400 * 2 ** attempt + Math.floor(Math.random() * 250);

/* Claude: system aparte, texto en content. Devuelve el texto plano. */
const callAnthropic = async ({ system, user, maxTokens, signal }) => {
  const res = await anthropic.messages.create(
    { model: config.llm.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] },
    { signal },
  );
  return res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
};

/* Gemini: systemInstruction en config, JSON forzado por responseMimeType.
   El texto se saca del getter res.text; extractJson igual lo sanea. */
const callGemini = async ({ system, user, maxTokens, signal }) => {
  const res = await gemini.models.generateContent({
    model: config.llm.geminiModel,
    contents: user,
    config: {
      systemInstruction: system,
      maxOutputTokens: maxTokens,
      responseMimeType: 'application/json',
      abortSignal: signal,
    },
  });
  return res.text ?? '';
};

const callOnce = async ({ system, user, maxTokens }) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const text =
      PROVIDER === 'gemini'
        ? await callGemini({ system, user, maxTokens, signal: ctrl.signal })
        : await callAnthropic({ system, user, maxTokens, signal: ctrl.signal });
    return extractJson(text);
  } finally {
    clearTimeout(timer);
  }
};

export const completeJson = async ({ system, user, maxTokens = config.llm.maxTokens, fallback }) => {
  if (!hasClient()) {
    if (fallback) return fallback();
    throw new HttpError(503, 'llm_disabled', 'El servicio de IA no esta configurado.');
  }

  const attemptAll = async () => {
    let lastErr;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await callOnce({ system, user, maxTokens });
      } catch (e) {
        lastErr = e;
        if (e instanceof JsonExtractError) throw new HttpError(502, 'llm_bad_output', e.message);
        if (!isTransient(e) || attempt === MAX_RETRIES) break;
        await sleep(backoff(attempt));
      }
    }
    const timedOut = lastErr?.name === 'AbortError';
    /* El error REAL del proveedor va al log. Sin esta linea, el 502 esconde si
       fue clave invalida (401), modelo inexistente (404), credito agotado (400)
       o proveedor caido (5xx) — y el diagnostico se vuelve adivinanza. La clave
       no se loguea jamas: solo status, tipo y mensaje. */
    console.error(
      '[llm] fallo real:',
      lastErr?.status ?? lastErr?.response?.status ?? '?',
      lastErr?.error?.error?.type ?? lastErr?.name ?? '?',
      String(lastErr?.message ?? '').slice(0, 300),
    );
    throw new HttpError(
      timedOut ? 504 : 502,
      timedOut ? 'llm_timeout' : 'llm_unavailable',
      'La IA no esta disponible en este momento.',
    );
  };

  return llmBreaker.run(attemptAll, fallback);
};

export const llmHealth = () => ({
  enabled: config.llm.enabled,
  provider: PROVIDER,        // qué proveedor está activo (anthropic | gemini): visible en /health
  model: activeModel(),      // el modelo en uso: un modelo viejo en el env se detecta mirando /health
  timeoutMs: TIMEOUT_MS,
  breaker: llmBreaker.snapshot(),
});
