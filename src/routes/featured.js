/**
 * Testimonios destacados. Reales o ninguno.
 *
 * Solo salen resenas de 4-5 estrellas, con comentario de verdad, y SOLO si la
 * persona puso su nombre. Sin nombre no hay testimonio: un testimonio anonimo
 * es indistinguible de uno inventado, y no queremos que nadie tenga que
 * confiar en nuestra palabra.
 *
 * Si no hay ninguno, devuelve una lista vacia y el frontend no monta la
 * seccion. El vacio es honesto; el relleno no.
 */
import { Router } from 'express';
import { query } from '../db.js';
import { asyncRoute } from '../middleware/errors.js';
import { LruCache } from '../lib/cache.js';

export const featuredRouter = Router();
const featCache = new LruCache({ max: 4, ttlMs: 10 * 60_000 });

featuredRouter.get(
  '/featured',
  asyncRoute(async (_req, res) => {
    const items = await featCache.wrap('featured', async () => {
      const { rows } = await query(
        `select stars, comment, name
           from reviews
          where stars >= 4
            and comment is not null
            and length(trim(comment)) between 40 and 320
            and name is not null
            and length(trim(name)) > 1
          order by created_at desc
          limit 3`,
      );
      return rows;
    });
    res.set('Cache-Control', 'public, max-age=600');
    res.json({ items });
  }),
);
