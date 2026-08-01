/* ¿Se permite este Origin? (CORS) — lógica PURA, testeable. Antes CORS era un solo
   origen (config.appUrl = mavante.com); la extensión de Chrome llama desde
   chrome-extension://<id> y quedaba bloqueada. Reglas:
     - Sin Origin (curl, health checks, same-origin) → sí.
     - El sitio (appUrl) → sí.
     - La extensión (chrome-extension://<id>): sí, pero si extOrigin está configurado
       (EXTENSION_ORIGIN con el id publicado) SOLO ese; si no, cualquiera (dev / mientras
       no está en la Store).
     - Todo lo demás → no (el navegador bloquea la lectura cross-origin; la auth server-side
       sigue siendo el freno real). */
export const isAllowedOrigin = (origin, appUrl, extOrigin = '') => {
  if (!origin) return true;
  if (origin === appUrl) return true;
  if (/^chrome-extension:\/\/[a-z0-9]{16,}$/i.test(origin)) {
    return extOrigin ? origin === extOrigin : true;
  }
  return false;
};
