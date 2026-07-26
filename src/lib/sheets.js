/**
 * src/lib/sheets.js
 * Sincronización a Google Sheets — reseñas, contacto e ingresos.
 *
 * DOS REGLAS QUE GOBIERNAN ESTE ARCHIVO:
 *
 *   1. NUNCA rompe el flujo principal. Cada append es fire-and-forget con reintento
 *      y traga su propio error: si Google Sheets se cae, se pierde ESA fila del
 *      espejo, pero el usuario que dejó la reseña, el que escribió, y sobre todo el
 *      WEBHOOK DE PAGO siguen intactos. La base de datos es la fuente de verdad; la
 *      planilla es una copia para leer cómodo.
 *   2. CERO dependencias nuevas. En vez del `googleapis` completo (~50MB, veneno para
 *      un deploy con poca RAM), autenticamos firmando el JWT de la cuenta de servicio
 *      con el `crypto` nativo de Node y hablamos la API REST de Sheets con `fetch`.
 *
 * Sin credenciales configuradas (config.sheets.enabled=false) TODO es no-op: el
 * sistema anda igual, simplemente no espeja a la planilla.
 */
import crypto from 'node:crypto';
import { config } from '../config.js';

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const b64url = (input) =>
  Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/* Fecha legible en hora de Argentina (la planilla la lee una persona, no una máquina).
   Si el runtime no tiene los datos de zona horaria, cae a ISO en vez de romper. */
const ahora = () => {
  try {
    return new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
  } catch {
    return new Date().toISOString();
  }
};

/* Token OAuth cacheado en memoria (vale ~1h). Se firma un JWT con la clave privada
   de la cuenta de servicio y se canjea por un access_token. */
let cachedToken = null;
let cachedExp = 0;
const getToken = async () => {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now < cachedExp - 60) return cachedToken;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(
    JSON.stringify({ iss: config.sheets.saEmail, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }),
  );
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const jwt = `${header}.${claim}.${b64url(signer.sign(config.sheets.saKey))}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`token ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const json = await res.json();
  cachedToken = json.access_token;
  cachedExp = now + (Number(json.expires_in) || 3600);
  return cachedToken;
};

const appendRaw = async (sheetId, tab, row) => {
  const token = await getToken();
  const range = encodeURIComponent(`${tab}!A1`);
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}` +
    ':append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS';
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [row] }),
  });
  if (!res.ok) throw new Error(`append ${res.status}: ${(await res.text()).slice(0, 160)}`);
};

/* El envoltorio seguro: no-op si no está configurado, reintenta ante un bache, y
   JAMÁS lanza hacia afuera. Un 401 invalida el token cacheado para re-pedirlo. */
const appendSafe = async (sheetId, tab, row, label) => {
  if (!config.sheets.enabled || !sheetId) return { skipped: true };
  for (let intento = 0; intento < 3; intento++) {
    try {
      await appendRaw(sheetId, tab, row);
      return { ok: true };
    } catch (e) {
      if (/\b401\b/.test(String(e.message))) cachedToken = null; // token vencido → re-pedir
      if (intento === 2) {
        console.warn(`[sheets] ${label} no se pudo escribir:`, e.message);
        return { ok: false, error: e.message };
      }
      await new Promise((r) => setTimeout(r, 400 * (intento + 1)));
    }
  }
  return { ok: false };
};

/* ── Filas por pestaña. El ORDEN de columnas es el contrato con la planilla. ── */

/** Pestaña "Reseñas": Fecha · Email · Puntuación · Texto · Estado. */
export const appendReviewRow = ({ stars, comment = '', name = '', email = '', page = '', lang = '' } = {}) =>
  appendSafe(
    config.sheets.feedbackId,
    'Reseñas',
    [ahora(), email || '', String(stars ?? ''), comment || '', 'Publicada', name || '', page || '', lang || ''],
    'reseña',
  );

/** Pestaña "Contacto": Fecha · Email · Nombre (asunto) · Mensaje. */
export const appendContactRow = ({ name = '', email = '', message = '', lang = '' } = {}) =>
  appendSafe(
    config.sheets.feedbackId,
    'Contacto',
    [ahora(), email || '', name || '', message || '', lang || ''],
    'contacto',
  );

/** Pestaña "Ingresos": Fecha · ID transacción · Email · Plan · Bruto · Comisión · Neto · Moneda · Proveedor. */
export const appendIncomeRow = ({
  txnId = '', email = '', plan = '', gross = '', fee = '', net = '', currency = '', provider = '',
} = {}) =>
  appendSafe(
    config.sheets.financeId,
    'Ingresos',
    [ahora(), String(txnId), email || '', plan || '', String(gross ?? ''), String(fee ?? ''), String(net ?? ''), currency || '', provider || ''],
    'ingreso',
  );

/** Para el smoke-test manual del setup: escribe una fila de prueba y devuelve el resultado. */
export const sheetsSelfTest = () =>
  appendSafe(config.sheets.feedbackId, 'Contacto', [ahora(), 'test@mavante.com', 'Prueba de conexión', 'Si ves esta fila, Sheets quedó conectado. Borrala.', 'es'], 'self-test');

export const sheetsEnabled = () => config.sheets.enabled;

/** Estado de configuración SIN secretos (para /health): revela si prendió y si las
    piezas llegaron, sin exponer la clave. keyLen ~1700 = clave OK; 0 = no llegó. */
export const sheetsStatus = () => ({
  enabled: config.sheets.enabled,
  feedbackId: Boolean(config.sheets.feedbackId),
  financeId: Boolean(config.sheets.financeId),
  saEmailTail: config.sheets.saEmail ? config.sheets.saEmail.slice(-24) : '',
  keyLen: config.sheets.saKey.length,
  keyLooksPem: config.sheets.saKey.includes('BEGIN PRIVATE KEY') && config.sheets.saKey.includes('\n'),
});

/** Diagnóstico NO destructivo: LEE los metadatos del sheet Feedback (auth + acceso +
    nombres de pestañas) sin escribir nada. Devuelve el error exacto si algo falla —
    la forma de saber si el problema es la clave (401), el compartir (403), el ID (404)
    o el nombre de la pestaña. */
export const sheetsDiag = async (doWrite = false) => {
  if (!config.sheets.enabled) return { enabled: false, motivo: 'config.sheets.enabled=false — falta alguna de las 4 env (o mal nombradas)' };
  if (!config.sheets.feedbackId) return { enabled: true, motivo: 'sin SHEET_FEEDBACK_ID' };
  const out = { enabled: true };
  try {
    const token = await getToken();
    // LECTURA de metadatos (auth + acceso + nombres de pestañas)
    const rget = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${config.sheets.feedbackId}?fields=properties.title,sheets.properties.title`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!rget.ok) { out.read = { ok: false, status: rget.status, error: (await rget.text()).slice(0, 220) }; return out; }
    const j = await rget.json();
    out.read = { ok: true, title: j.properties?.title, tabs: (j.sheets || []).map((s) => s.properties?.title) };
    // ESCRITURA de prueba (solo si se pide): revela el error EXACTO del append.
    if (doWrite) {
      const range = encodeURIComponent('Contacto!A1');
      const rput = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${config.sheets.feedbackId}/values/${range}` +
          ':append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: [[ahora(), 'diag@mavante.com', 'DIAGNÓSTICO DE ESCRITURA', 'Si ves esta fila, el append funciona. Borrala.', 'es']] }),
        },
      );
      out.write = { ok: rput.ok, status: rput.status, body: (await rput.text()).slice(0, 320) };
    }
    return out;
  } catch (e) {
    out.error = String(e.message).slice(0, 220);
    return out;
  }
};
