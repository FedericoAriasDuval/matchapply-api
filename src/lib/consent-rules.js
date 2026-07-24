/**
 * src/lib/consent-rules.js
 *
 * Reglas PURAS del consentimiento (sin base de datos). Separadas de consent.js
 * —que sí toca la DB— para poder testearlas sin levantar nada.
 */

/**
 * ¿El payload del alta pide compartir el perfil con empresas?
 *
 * Acepta el nombre nuevo (`isVisibleToCompanies`) y el viejo (`isDiscoverable`,
 * pre rename de la migración 005), y por defecto NO (opt-in). Acá vivía el bug:
 * el front mandaba `isDiscoverable`, el back leía `isVisibleToCompanies`, no
 * coincidían, y el consentimiento que la persona tildaba se perdía en silencio.
 */
export const wantsCompanyVisibility = (body) =>
  Boolean(body?.isVisibleToCompanies ?? body?.isDiscoverable ?? false);
