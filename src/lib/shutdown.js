/**
 * src/lib/shutdown.js
 * El apagado ordenado, separado del server para poder PROBARLO.
 *
 * POR QUÉ VIVE ACÁ Y NO DENTRO DE server.js
 * Es el código que corre en cada deploy, o sea el que más veces se ejecuta en
 * producción y el que menos se ejercita en desarrollo. Dejarlo enterrado en un
 * `process.on('SIGTERM')` significa que solo se prueba en vivo, el día que falla.
 * Acá recibe sus piezas por parámetro y se puede simular un deploy en un test.
 *
 * EL ORDEN IMPORTA, y cada paso tiene un motivo:
 *   1. Cerrar el listener  → no entra trabajo nuevo.
 *   2. Drenar la cola      → los CVs que ya estaban en el horno se terminan.
 *      Al usuario ya le descontamos la cuota: cortarle el análisis por un deploy
 *      nuestro sería cobrarle por nada.
 *   3. Cerrar el pool      → recién ahí soltamos la base, no antes: si la
 *      soltáramos primero, los análisis que están terminando no podrían guardar.
 */

/**
 * @param {object} o
 * @param {{close:Function}} o.server        el servidor HTTP
 * @param {{drain:Function, snapshot:Function}} o.queue  la cola de CVs
 * @param {{end:Function}} o.pool            el pool de Postgres
 * @param {number} [o.drainMs]               cuánto esperamos a que termine el trabajo vivo
 * @param {Function} [o.log] @param {Function} [o.warn] @param {Function} [o.error]
 * @returns {Promise<{limpio:boolean, pasos:string[]}>}
 */
export const cerrarOrdenado = async ({
  server, queue, pool,
  drainMs = 25_000,
  log = console.log, warn = console.warn, error = console.error,
}) => {
  const pasos = [];

  try { server.close(() => {}); pasos.push('listener'); }
  catch (e) { error('[shutdown] cerrando el listener:', e.message); }

  let limpio = false;
  try {
    limpio = await queue.drain(drainMs);
    pasos.push('cola');
    if (!limpio) {
      const q = queue.snapshot();
      warn(`[shutdown] se corta con trabajo vivo: ${q.running} corriendo, ${q.waiting} en fila`);
    }
  } catch (e) {
    error('[shutdown] drenando la cola:', e.message);
  }

  /* El pool se cierra SIEMPRE, aunque el drenaje haya fallado: una conexión
     colgada contra Neon sobrevive al proceso y consume una plaza del límite. */
  try { await pool.end(); pasos.push('pool'); }
  catch (e) { error('[shutdown] cerrando el pool:', e.message); }

  log('[shutdown] listo:', pasos.join(' → '));
  return { limpio, pasos };
};
