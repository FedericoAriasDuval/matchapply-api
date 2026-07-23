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
import { config } from '../config.js';
import { HttpError } from '../middleware/errors.js';
import { JsonExtractError, extractJson } from './json.js';
import { llmBreaker } from './breaker.js';

export { extractJson } from './json.js';

const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 30000);
const MAX_RETRIES = 2;

/* PRESUPUESTO TOTAL de la operación, reintentos y esperas incluidos.
 *
 * Sin esto los dos timeouts del sistema se contradecían: la cola abandona a los
 * 45 s (CV_TIMEOUT_MS) y le contesta al usuario, pero acá seguíamos reintentando
 * hasta ~95 s (3 intentos de 30 s + backoff). O sea: pagábamos llamadas a la IA
 * que ya no le importaban a nadie, y encima ocupábamos memoria de un proceso que
 * en el pico la necesita para los que SÍ están esperando.
 *
 * 40 s deja margen bajo los 45 de la cola: si vamos a fallar, fallamos antes de
 * que nos corten, y el usuario recibe el error nuestro —humano— y no un timeout. */
const BUDGET_MS = Number(process.env.LLM_BUDGET_MS ?? 40000);

/* Dos proveedores, un solo cliente. El flag LLM_PROVIDER decide cuál se usa;
   todo el blindaje de abajo (timeout, reintentos, breaker, fallback) es igual
   para los dos. Cambiar de proveedor NO toca ninguna otra parte del sistema. */
const PROVIDER = config.llm.provider === 'gemini' ? 'gemini' : 'anthropic';

const anthropic = (PROVIDER === 'anthropic' && config.llm.enabled)
  ? new Anthropic({ apiKey: config.llm.apiKey, maxRetries: 0 })
  : null;
/* Gemini se carga SOLO si de verdad se va a usar (import dinámico dentro de la
   llamada). Antes se importaba siempre, y eso significaba que un paquete que hoy
   no usamos podía impedir que arrancara TODA la API: si `@google/genai` faltaba
   o se rompía en un deploy, Mavante no levantaba aunque el motor activo fuera
   Claude. Un proveedor dormido no puede tener poder de veto sobre el arranque.
   De paso, no se paga su memoria en un plan con poca RAM. */
let gemini = null;
const getGemini = async () => {
  if (!gemini) {
    const { GoogleGenAI } = await import('@google/genai');
    gemini = new GoogleGenAI({ apiKey: config.llm.geminiKey });
  }
  return gemini;
};

const hasClient = () => (PROVIDER === 'gemini' ? Boolean(config.llm.geminiKey) : !!anthropic);
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

/* ¿El modelo acepta que le apaguemos el razonamiento interno? Se APRENDE en
   caliente: si la API rechaza el parámetro, se deja de mandar para siempre en
   este proceso. Así el arreglo funciona donde está soportado y no puede romper
   nada donde no lo está — que es la única forma responsable de tocar el
   parámetro de una llamada que hoy paga y usa gente real. */
let mandarThinkingOff = true;

/* Claude: system aparte, texto en content. Devuelve el texto plano.
 *
 * EL 502 DETERMINÍSTICO DE LOS CVs DIFÍCILES (23/07/2026, CV de dos columnas).
 * claude-sonnet-5 razona internamente POR DEFECTO, y ese razonamiento sale del
 * MISMO max_tokens que la respuesta. Con un texto revuelto —el que producía
 * pdf.js antes de reconstruir las columnas— el modelo deliberaba largo, se
 * quedaba sin presupuesto y devolvía el JSON cortado (o nada). extractJson
 * fallaba, y como el input no cambia entre reintentos, fallaba las tres veces:
 * 502 sin un solo timeout. Exactamente la firma que mostró /health (fail:3,
 * timedOut:0).
 * Dos defensas: se apaga el razonamiento (para extraer campos de un CV no
 * aporta nada) y se MIRA el stop_reason, que es el dato que convertía esto en
 * una caja negra: truncado, rechazo y respuesta vacía eran indistinguibles. */
const callAnthropic = async ({ system, user, maxTokens, signal }) => {
  const params = { model: config.llm.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] };
  if (mandarThinkingOff) params.thinking = { type: 'disabled' };

  let res;
  try {
    res = await anthropic.messages.create(params, { signal });
  } catch (e) {
    /* El modelo no conoce el parámetro: se anota y se reintenta YA, sin que el
       usuario se entere. Solo para un 400 que hable de thinking — cualquier otro
       400 es un problema real y tiene que subir. */
    const s = e?.status ?? e?.response?.status;
    if (mandarThinkingOff && s === 400 && /thinking|unexpected|unrecognized/i.test(String(e?.message ?? ''))) {
      mandarThinkingOff = false;
      console.warn('[llm] este modelo no acepta thinking:disabled — se deja de mandar:', String(e?.message ?? '').slice(0, 160));
      delete params.thinking;
      res = await anthropic.messages.create(params, { signal });
    } else {
      throw e;
    }
  }

  const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  /* Un texto vacío o un corte por presupuesto NO es "JSON inválido": es otra
     falla, con otra causa y otro arreglo. Se le pone nombre acá para que el log
     final lo diga en vez de esconderlo detrás de un genérico. */
  if (!text.trim() || res.stop_reason === 'max_tokens' || res.stop_reason === 'refusal') {
    const e = new Error(
      res.stop_reason === 'max_tokens'
        ? 'El modelo se quedó sin presupuesto de tokens antes de terminar el JSON.'
        : res.stop_reason === 'refusal'
          ? 'El modelo se negó a responder.'
          : 'El modelo devolvió una respuesta vacía.',
    );
    e.name = 'ModelOutputError';
    e.stopReason = res.stop_reason ?? '?';
    e.usage = res.usage ? `in=${res.usage.input_tokens} out=${res.usage.output_tokens}` : '?';
    e.textLen = text.length;
    throw e;
  }
  return text;
};

/* Gemini: systemInstruction en config, JSON forzado por responseMimeType.
   El texto se saca del getter res.text; extractJson igual lo sanea.

   thinkingBudget: 0 APAGA el razonamiento interno. SOLO los modelos 2.5 traen el
   thinking prendido por defecto (costaba ~22s por parseo + tokens facturados, y
   para extraer un CV a JSON no aporta). A los 2.0 NO se les manda el campo:
   pasarselo a un modelo que no lo soporta puede dar 400. */
const callGemini = async ({ system, user, maxTokens, signal }) => {
  const cfg = {
    systemInstruction: system,
    maxOutputTokens: maxTokens,
    responseMimeType: 'application/json',
    abortSignal: signal,
  };
  if (config.llm.geminiModel.includes('2.5')) cfg.thinkingConfig = { thinkingBudget: 0 };
  const g = await getGemini();
  const res = await g.models.generateContent({
    model: config.llm.geminiModel,
    contents: user,
    config: cfg,
  });
  return res.text ?? '';
};

const callOnce = async ({ system, user, maxTokens, timeoutMs = TIMEOUT_MS }) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const text =
      PROVIDER === 'gemini'
        ? await callGemini({ system, user, maxTokens, signal: ctrl.signal })
        : await callAnthropic({ system, user, maxTokens, signal: ctrl.signal });
    try {
      return extractJson(text);
    } catch (e) {
      /* Guardamos QUÉ devolvió el modelo (recortado, sin exponer el CV entero):
         sin esto, un JSON malformado o truncado era una caja negra. */
      if (e instanceof JsonExtractError) {
        e.rawSnippet = `len=${(text || '').length} · ini=${JSON.stringify(String(text || '').slice(0, 140))} · fin=${JSON.stringify(String(text || '').slice(-80))}`;
      }
      throw e;
    }
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
    const t0 = Date.now();
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      /* Cada intento se recorta a lo que queda de presupuesto: el último no
         puede pasarse de los 40 s aunque el timeout suelto diga 30. */
      const restante = BUDGET_MS - (Date.now() - t0);
      if (restante <= 1000) break;
      try {
        return await callOnce({ system, user, maxTokens, timeoutMs: Math.min(TIMEOUT_MS, restante) });
      } catch (e) {
        lastErr = e;
        /* Un JSON malformado o truncado casi nunca es determinístico: regenerar
           suele traer uno bueno. Antes se tiraba de una sin reintentar, y un solo
           mal muestreo del modelo se convertía en un 502 para el usuario. Ahora
           se reintenta igual que un error transitorio. */
        /* ModelOutputError (vacío / cortado / rechazo) también se reintenta: el
           muestreo cambia entre llamadas y la segunda suele salir entera. */
        const reintentable = isTransient(e) || e instanceof JsonExtractError || e?.name === 'ModelOutputError';
        if (!reintentable || attempt === MAX_RETRIES) break;
        const espera = backoff(attempt);
        /* No arrancamos un reintento que no va a llegar a tiempo: esperar para
           después abandonar es gastar el doble y contestar más tarde. */
        if (Date.now() - t0 + espera + 2000 >= BUDGET_MS) break;
        await sleep(espera);
      }
    }
    const timedOut = lastErr?.name === 'AbortError';
    const salidaMala = lastErr?.name === 'ModelOutputError';
    const badOutput = lastErr instanceof JsonExtractError || salidaMala;
    /* El error REAL del proveedor va al log. Sin esta linea, el 502 esconde si
       fue clave invalida (401), modelo inexistente (404), credito agotado (400),
       proveedor caido (5xx) o JSON malformado — y el diagnostico se vuelve
       adivinanza. La clave no se loguea jamas: solo status, tipo, mensaje y (si
       fue JSON malo) un recorte de lo que devolvio el modelo. */
    console.error(
      '[llm] fallo real:',
      lastErr?.status ?? lastErr?.response?.status ?? '?',
      lastErr?.error?.error?.type ?? lastErr?.name ?? '?',
      String(lastErr?.message ?? '').slice(0, 300),
      badOutput && lastErr?.rawSnippet ? `| output: ${lastErr.rawSnippet}` : '',
      /* stop_reason es EL dato que faltaba: sin él, "se cortó por presupuesto",
         "se negó" y "devolvió vacío" eran el mismo 502 mudo. */
      salidaMala ? `| stop_reason=${lastErr.stopReason} usage=${lastErr.usage} textLen=${lastErr.textLen}` : '',
      `| modelo=${activeModel()} thinkingOff=${mandarThinkingOff}`,
    );
    throw new HttpError(
      badOutput ? 502 : timedOut ? 504 : 502,
      badOutput ? 'llm_bad_output' : timedOut ? 'llm_timeout' : 'llm_unavailable',
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
