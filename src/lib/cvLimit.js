/**
 * Decisión PURA del tope de CVs guardados por usuario. Sin dependencias (ni config,
 * ni base): el handler le pasa todo. Vive acá —y no en la ruta— para poder testearla
 * en aislamiento (importar la ruta arrastra config, que exige variables de entorno).
 *
 * El fundador y Pro NUNCA se topan (Pro = Infinity). Es distinto de la cuota diaria de
 * IA: esto cuenta CUÁNTOS CVs distintos guarda una persona en su panel, no operaciones.
 *
 * @param {{ isFounder:boolean, tier:string, count:number, limits:{free:number,pro:number} }} o
 */
export const cvLimitReached = ({ isFounder, tier, count, limits }) => {
  if (isFounder) return false;
  const cap = tier === 'pro' ? limits.pro : limits.free;
  return count >= cap;
};
