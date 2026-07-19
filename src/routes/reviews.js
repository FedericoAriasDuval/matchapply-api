/**
 * src/routes/reviews.js
 * Reseñas privadas + resumen ejecutivo para los fundadores.
 *
 * DOS DECISIONES QUE IMPORTAN:
 *
 * 1. SE ESCRIBEN, NO SE LEEN. Hay POST publico y NO hay GET publico. Ni siquiera
 *    existe el endpoint. Una resena mala no puede "perderse" si nadie tiene el
 *    poder de borrarla de la vista: simplemente no hay vista.
 *
 * 2. LA IP NO SE GUARDA. Se guarda un hash. Alcanza para detectar abuso (mil
 *    resenas del mismo origen) y no alcanza para identificar a nadie. Pedirle a
 *    alguien que sea sincero y a la vez anotarle la IP es una contradiccion.
 */
import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { asyncRoute, unauthorized } from '../middleware/errors.js';
import { reviewLimiter } from '../middleware/rateLimit.js';
import { adminTokenOk } from './admin.js';
import { completeJson } from '../lib/llm.js';

export const reviewsRouter = Router();

const hashIp = (ip) =>
  crypto.createHash('sha256').update(String(ip || '') + (process.env.JWT_SECRET || '')).digest('hex').slice(0, 32);

const schema = z.object({
  stars: z.number().int().min(1).max(5),
  comment: z.string().trim().max(2000).optional().default(''),
  name: z.string().trim().max(80).optional().default(''),
  page: z.string().trim().max(80).optional().default(''),
  lang: z.string().trim().max(5).optional().default('es'),
});

/* ---------------------------------------------------------------- ESCRIBIR */
reviewsRouter.post(
  '/',
  reviewLimiter,
  asyncRoute(async (req, res) => {
    const body = schema.parse(req.body);
    await query(
      `insert into reviews (user_id, stars, comment, name, page, lang, user_agent, ip_hash)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        req.user?.id ?? null,
        body.stars,
        body.comment || null,
        body.name || null,
        body.page || null,
        body.lang,
        req.get('user-agent')?.slice(0, 200) ?? null,
        hashIp(req.ip),
      ],
    );
    /* No devolvemos nada: ni un id, ni un listado. No hay nada que mostrar. */
    res.status(201).json({ ok: true });
  }),
);

/* ------------------------------------------------------- RESUMEN EJECUTIVO */
/* Protegido con ADMIN_TOKEN. No es una pantalla de admin: es una lectura para
   los dos, y no queremos construir un panel que nadie va a mirar dos veces. */
const requireAdmin = (req, _res, next) => {
  if (!adminTokenOk(req.get('x-admin-token'))) {
    return next(unauthorized('admin_only', 'Solo para los fundadores.'));
  }
  next();
};

reviewsRouter.get(
  '/summary',
  requireAdmin,
  asyncRoute(async (req, res) => {
    const days = Math.min(Number(req.query.days ?? 30), 365);

    const { rows: stats } = await query(
      `select count(*)::int                                   as total,
              round(avg(stars)::numeric, 2)                   as promedio,
              count(*) filter (where stars >= 4)::int         as promotores,
              count(*) filter (where stars = 3)::int          as neutros,
              count(*) filter (where stars <= 2)::int         as detractores,
              count(*) filter (where comment is not null)::int as con_comentario
         from reviews
        where created_at > now() - ($1 || ' days')::interval`,
      [days],
    );

    const { rows: comments } = await query(
      `select stars, comment, created_at
         from reviews
        where comment is not null and created_at > now() - ($1 || ' days')::interval
        order by created_at desc
        limit 200`,
      [days],
    );

    const s = stats[0];
    /* NPS clasico: % promotores - % detractores. Con menos de 10 respuestas no
       significa nada, y decirlo es mas honesto que mostrar un numero bonito. */
    const nps =
      s.total > 0 ? Math.round(((s.promotores - s.detractores) / s.total) * 100) : null;

    const base = {
      periodo_dias: days,
      total: s.total,
      promedio: s.promedio ? Number(s.promedio) : null,
      nps,
      nps_confiable: s.total >= 10,
      distribucion: { promotores: s.promotores, neutros: s.neutros, detractores: s.detractores },
    };

    if (!comments.length) {
      return res.json({ ...base, resumen: 'Todavia no hay comentarios para resumir.' });
    }

    /* La IA lee los comentarios y arma el resumen. Si no esta disponible, el
       fallback devuelve los comentarios crudos: preferimos que los leas vos a
       que no leas nada. */
    const texto = comments
      .map((c) => `[${c.stars}/5] ${String(c.comment).replace(/\s+/g, ' ').slice(0, 400)}`)
      .join('\n');

    const resumen = await completeJson({
      system:
        'Sos analista de producto. Recibis resenas reales de usuarios de una plataforma de ' +
        'empleabilidad. Devolves JSON con esta forma exacta: ' +
        '{"funciona_bien":[{"tema":string,"evidencia":string,"menciones":number}],' +
        '"hay_que_arreglar":[{"tema":string,"evidencia":string,"menciones":number,"urgencia":"alta"|"media"|"baja"}],' +
        '"cita_destacada":string,"veredicto":string}. ' +
        'Reglas: agrupa por TEMA, no repitas resenas una por una. La evidencia tiene que ser una ' +
        'cita textual corta. No inventes temas que nadie menciono. Si algo se menciona una sola vez, ' +
        'decilo (menciones:1) en vez de inflarlo. Se directo: esto lo leen los fundadores para decidir ' +
        'que tocar manana, no para sentirse bien.',
      user: `Resenas de los ultimos ${days} dias (${comments.length}):\n\n${texto}`,
      maxTokens: 1500,
      fallback: () => ({
        funciona_bien: [],
        hay_que_arreglar: [],
        cita_destacada: '',
        veredicto:
          'La IA no esta disponible. Abajo van los comentarios crudos: leelos vos, que igual es lo que hay que hacer.',
        comentarios_crudos: comments.map((c) => ({ stars: c.stars, comment: c.comment })),
      }),
    });

    res.json({ ...base, resumen });
  }),
);
