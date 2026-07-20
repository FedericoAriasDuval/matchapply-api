/**
 * src/routes/corporate.js
 * El panel de empresas. Namespace propio (/corporate/*) para no ensuciar el
 * flujo B2C: acá adentro NO hay cookies de usuario, no hay sesiones del sitio y
 * no se toca nada de lo que usa una persona.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LAS TRES REGLAS QUE NO SE NEGOCIAN
 *
 * 1. NADIE ENTRA SIN QUE ALGUIEN LO HAYA DEJADO ENTRAR. No hay auto-registro de
 *    empresas: se dan de alta a mano (ver scripts/company.js). Cada empresa que
 *    entra mira datos de personas reales — esa puerta la abre un humano.
 *
 * 2. LA VISIBILIDAD SE PREGUNTA EN LA BASE, EN CADA CONSULTA. Sin caché, sin
 *    trabajos nocturnos, sin listas precalculadas. Si alguien se dio de baja
 *    hace tres segundos, la próxima consulta ya no lo trae. Un caché acá no es
 *    una optimización: es una persona que dijo "no" y sigue apareciendo.
 *
 * 3. EL CONTACTO SALE DE UN SOLO LUGAR: un interés en estado 'accepted' de ESA
 *    empresa con ESA persona. No hay atajo, ni parámetro, ni endpoint alterno.
 * ════════════════════════════════════════════════════════════════════════════
 */
import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db.js';
import { perfilAnonimo, contactoRevelado } from '../lib/anon.js';
import { readCvRow } from './cv.js';
import { badRequest, unauthorized, HttpError } from '../middleware/errors.js';
import { corporateLimiter } from '../middleware/rateLimit.js';

export const corporateRouter = Router();

/* La clave viaja como Bearer y en la base vive HASHEADA. Guardar la clave en
   claro sería regalarle a un dump de Postgres el acceso al panel entero. */
export const hashApiKey = (raw) => crypto.createHash('sha256').update(String(raw ?? '')).digest('hex');

/** Autentica a la EMPRESA. Nunca carga un usuario del sitio: son mundos aparte. */
const authCompany = async (req, _res, next) => {
  try {
    const raw = req.get('authorization')?.replace(/^Bearer\s+/i, '')?.trim();
    if (!raw) throw unauthorized('company_auth', 'Falta la clave de acceso.');

    /* Se busca POR EL HASH: así la comparación la hace el índice único de
       Postgres y no hay que traer todas las claves para compararlas a mano. */
    const { rows } = await query(
      `select id, name, sector, size_label, is_active from companies where api_key_hash = $1`,
      [hashApiKey(raw)],
    );
    const empresa = rows[0];
    if (!empresa || !empresa.is_active) throw unauthorized('company_auth', 'Clave inválida o cuenta desactivada.');

    req.company = empresa;
    next();
  } catch (e) {
    next(e);
  }
};

/* El interruptor de config.talentPanel se chequea ANTES que la clave: con el
   panel apagado, la ruta directamente no existe — ni siquiera confirma que el
   endpoint exista, que es lo que uno quiere de una función dormida. */
const panelOn = (_req, _res, next) =>
  next(config.talentPanel.enabled ? undefined : new HttpError(404, 'not_found', 'No encontramos eso.'));

corporateRouter.use(panelOn, corporateLimiter, authCompany);

/* ═══════════════════════ El CV más reciente de cada persona ═══════════════════
   Una sola consulta con DISTINCT ON en vez de N+1: el panel trae 20 perfiles y
   hacer 20 viajes a la base por página es la forma más fácil de que esto se
   ponga lento el día que funcione. */
const traerPerfilesVisibles = async ({ limit, offset, skill }) => {
  const { rows } = await query(
    `select distinct on (u.id)
            u.id, u.visible_since, c.data
       from users u
       join cv_documents c on c.user_id = u.id
      where u.is_visible_to_companies = true      -- LA fuente de verdad, en vivo
        and u.is_verified = true
      order by u.id, c.updated_at desc`,
  );

  /* El descifrado y el anonimizado pasan en memoria, después de la base: la
     columna `data` está cifrada, así que no se puede filtrar por SQL. */
  let perfiles = rows
    .map((r) => {
      const doc = readCvRow({ id: r.id, data: r.data });
      return doc ? perfilAnonimo({ id: r.id, visible_since: r.visible_since }, doc.data) : null;
    })
    .filter(Boolean);

  if (skill) {
    const s = String(skill).toLowerCase();
    perfiles = perfiles.filter((p) => p.skills.some((k) => k.toLowerCase().includes(s)));
  }

  perfiles.sort((a, b) => String(b.visibleSince ?? '').localeCompare(String(a.visibleSince ?? '')));
  return { total: perfiles.length, items: perfiles.slice(offset, offset + limit) };
};

/**
 * GET /corporate/profiles — el listado ANÓNIMO.
 * Cada objeto lo arma perfilAnonimo() con lista blanca: acá no se "borran"
 * campos, se copian solo los permitidos.
 */
corporateRouter.get('/profiles', async (req, res, next) => {
  try {
    const { limit, offset, skill } = z
      .object({
        limit: z.coerce.number().int().min(1).max(50).optional().default(20),
        offset: z.coerce.number().int().min(0).optional().default(0),
        skill: z.string().trim().max(60).optional(),
      })
      .parse(req.query);

    res.json(await traerPerfilesVisibles({ limit, offset, skill }));
  } catch (e) {
    next(e instanceof z.ZodError ? badRequest('invalid_payload', 'Parámetros inválidos.') : e);
  }
});

/**
 * POST /corporate/interest — "me interesa este perfil".
 * NO revela nada: solo deja el pedido anotado para que la persona decida.
 */
corporateRouter.post('/interest', async (req, res, next) => {
  try {
    const { profileId, message } = z
      .object({
        profileId: z.string().uuid(),
        message: z.string().trim().max(600).optional(),
      })
      .parse(req.body);

    /* Se re-verifica la visibilidad ACÁ y no se confía en que el perfil vino
       del listado: entre que la empresa cargó la página y apretó el botón, la
       persona pudo haberse dado de baja. */
    const { rows: u } = await query(
      `select id from users where id = $1 and is_visible_to_companies = true and is_verified = true`,
      [profileId],
    );
    if (!u[0]) throw badRequest('profile_unavailable', 'Ese perfil ya no está disponible.');

    /* El unique (company_id,user_id) de la base hace el resto: si ya pidió, no
       se crea otro. Un "no" no se puede convertir en acoso a fuerza de insistir. */
    const { rows } = await query(
      `insert into company_interests (company_id, user_id, message)
       values ($1, $2, $3)
       on conflict (company_id, user_id) do nothing
       returning id, status, created_at`,
      [req.company.id, profileId, message ?? null],
    );

    if (!rows[0]) {
      const { rows: prev } = await query(
        `select id, status, created_at from company_interests where company_id = $1 and user_id = $2`,
        [req.company.id, profileId],
      );
      return res.status(200).json({ interest: prev[0], alreadySent: true });
    }
    res.status(201).json({ interest: rows[0], alreadySent: false });
  } catch (e) {
    next(e instanceof z.ZodError ? badRequest('invalid_payload', 'Datos inválidos.') : e);
  }
});

/**
 * GET /corporate/contacts — los contactos que la empresa YA tiene permiso de ver.
 *
 * El permiso no es un parámetro ni una bandera de sesión: es una fila con
 * status='accepted'. El join lo garantiza. Si la persona nunca aceptó, su
 * contacto no puede salir de acá aunque el resto del código se equivoque.
 */
corporateRouter.get('/contacts', async (req, res, next) => {
  try {
    const { rows } = await query(
      `select distinct on (u.id)
              u.id, u.name, u.email, c.data, ci.resolved_at
         from company_interests ci
         join users u on u.id = ci.user_id
         join cv_documents c on c.user_id = u.id
        where ci.company_id = $1
          and ci.status = 'accepted'              -- EL permiso, y el unico
        order by u.id, c.updated_at desc`,
      [req.company.id],
    );

    res.json({
      items: rows.map((r) => {
        const doc = readCvRow({ id: r.id, data: r.data });
        return { ...contactoRevelado(r, doc?.data), acceptedAt: r.resolved_at };
      }),
    });
  } catch (e) {
    next(e);
  }
});

/** Quién soy, para que el panel muestre su propio nombre. */
corporateRouter.get('/me', (req, res) =>
  res.json({ company: { id: req.company.id, name: req.company.name, sector: req.company.sector } }));
