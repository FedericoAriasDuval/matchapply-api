/**
 * src/routes/stats.js
 * Los numeros PROPIOS. Publicos, reales, y sin adornos.
 *
 * LA REGLA, y no es negociable:
 * Este endpoint devuelve lo que hay en la base. Si hay 7 CVs, dice 7. No hay un
 * "numero base" para que se vea mejor, no hay multiplicador, no hay redondeo
 * hacia arriba. El frontend decide si vale la pena mostrarlo (hoy: a partir de
 * 50), pero la API nunca miente.
 *
 * Un contador inflado es la mentira mas facil de contar y la mas facil de
 * descubrir: alguien mira el numero el lunes, vuelve el martes, y si creci
 * 4.000 en un dia sin que nadie hable de nosotros, se dio cuenta.
 */
import { Router } from 'express';
import { query } from '../db.js';
import { asyncRoute } from '../middleware/errors.js';
import { LruCache } from '../lib/cache.js';

export const statsRouter = Router();

/* Cache de 5 minutos: este endpoint lo pega TODA visita a la home. Sin cache,
   el dia del lanzamiento seria un COUNT(*) por visitante. */
const statsCache = new LruCache({ max: 4, ttlMs: 5 * 60_000 });

statsRouter.get(
  '/',
  asyncRoute(async (_req, res) => {
    const data = await statsCache.wrap('public', async () => {
      const { rows } = await query(
        `select
           (select count(*) from cv_documents)::int                        as cvs,
           (select count(*) from users where is_verified = true)::int      as users,
           (select count(*) from reviews where stars >= 4)::int            as happy`,
      );
      return rows[0];
    });

    /* Solo lo que es cierto. Nada mas. */
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ cvs: data.cvs, users: data.users, happy: data.happy });
  }),
);
