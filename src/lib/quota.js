/* Lógica PURA de la cuota por acción (sin base de datos → testeable).
   El motor con DB vive en routes/cv.js y se apoya en esto. Rediseño 31/07:
   límites por acción (diagnóstico/adaptación) con ventana según el tier
   (free='life' de por vida, plus='month' mensual, pro='none' sin tope). */

/** Límite + ventana para (tier, acción), leídos de config.limits / config.quotaWindow.
    Tier desconocido → free (nunca ilimitado por accidente). Acción sin entrada en
    limits (carta/entrevista) → ilimitada (max Infinity). */
export const quotaSpec = (tier, action, limits, windows) => {
  const t = limits[tier] ? tier : 'free';
  const max = limits[t][action];
  return { max: max === undefined ? Infinity : max, window: windows[t] || 'life' };
};

/** Clave de período de un uso: 'life' (de por vida) o 'AAAA-MM' (mensual).
    `now` es inyectable para poder testear el corte de mes sin depender del reloj. */
export const periodKey = (window, now = new Date()) =>
  window === 'month' ? now.toISOString().slice(0, 7) : 'life';

/** ¿La acción NO se cuenta para este spec? Pro (window 'none') o acción sin tope. */
export const isUncounted = (spec) => spec.window === 'none' || !Number.isFinite(spec.max);
