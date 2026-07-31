/**
 * Decisión PURA del tope de CVs guardados por usuario. Sin dependencias (ni config,
 * ni base): el handler le pasa todo. Vive acá —y no en la ruta— para poder testearla
 * en aislamiento (importar la ruta arrastra config, que exige variables de entorno).
 *
 * El fundador y Pro NUNCA se topan (Pro = Infinity). Es distinto de la cuota diaria de
 * IA: esto cuenta CUÁNTOS CVs distintos guarda una persona en su panel, no operaciones.
 *
 * El tope sale de `limits[tier]` (free/plus/pro); si el tier no está en la tabla,
 * cae al de free — nunca a "sin tope" por un valor inesperado.
 *
 * @param {{ isFounder:boolean, tier:string, count:number, limits:Record<string,number> }} o
 */
export const cvLimitReached = ({ isFounder, tier, count, limits }) => {
  if (isFounder) return false;
  const cap = limits[tier] ?? limits.free;
  return count >= cap;
};
