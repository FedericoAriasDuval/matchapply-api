import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({
  connectionString: config.db.url,
  ssl: config.db.ssl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => console.error('[pg] error inesperado en el pool:', err.message));

export const query = (text, params) => pool.query(text, params);

/** Ejecuta una función dentro de una transacción. */
export const tx = async (fn) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    /* Si la conexión ya está muerta, el ROLLBACK también falla — y ese segundo
       error TAPABA al primero, que es el único que explica qué pasó de verdad.
       Perder la causa raíz por culpa de la limpieza convierte un bug de diez
       minutos en una tarde de adivinanzas. */
    try {
      await client.query('ROLLBACK');
    } catch (errRollback) {
      console.error('[pg] el ROLLBACK tambien fallo:', errRollback.message);
    }
    throw e;
  } finally {
    client.release();
  }
};
