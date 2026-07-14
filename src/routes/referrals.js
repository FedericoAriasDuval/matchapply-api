// =====================================================================
// REFERIDOS
//
// "Invitá a un amigo y los dos se llevan 5 simulaciones."
//
// La regla que ordena todo este archivo: el crédito se paga cuando el
// invitado VERIFICA SU EMAIL, no cuando hace clic en el link. Un programa de
// referidos que paga por clic no consigue usuarios: consigue cuentas falsas,
// y el primero en darse cuenta va a ser alguien que quiera romperlo.
//
// Sobre el número 5: no es un número redondo elegido por lindo. Una entrevista
// real tiene entre 4 y 6 preguntas de fondo. 5 simulaciones es una entrevista
// completa — suficiente para que la persona sepa si esto le sirve. Menos sería
// una demo; más sería regalar el producto.
// =====================================================================
import { Router } from 'express';
import { query, tx } from '../db.js';
import { newCode, looksLikeCode } from '../lib/refcode.js';
import { authenticate } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errors.js';

export const referralsRouter = Router();
const router = referralsRouter;

/** Cuántas simulaciones se lleva cada lado. Los dos igual: si el que invita
 *  gana más que el invitado, el invitado se siente usado — y con razón. */
export const SIMS_PER_REFERRAL = 5;

/** Devuelve el código del usuario, creándolo la primera vez.
 *  Es estable: si alguien ya compartió su link, ese link sigue funcionando
 *  para siempre. Un link de referido que caduca es una promesa rota. */
const ensureCode = async (userId) => {
  const { rows } = await query(`select code from referral_codes where user_id = $1`, [userId]);
  if (rows[0]) return rows[0].code;

  // El unique de `code` es la red de seguridad ante una colisión.
  // Con 2.7e10 combinaciones no debería pasar nunca, pero "no debería pasar
  // nunca" no es una estrategia: reintentamos 5 veces y listo.
  for (let i = 0; i < 5; i++) {
    const code = newCode();
    const { rows: ins } = await query(
      `insert into referral_codes (user_id, code) values ($1, $2)
       on conflict (code) do nothing
       returning code`,
      [userId, code],
    );
    if (ins[0]) return ins[0].code;
  }
  throw new Error('referral_code_generation_failed');
};

// ---------------------------------------------------------------------
// GET /referrals/me — mi link y mi saldo. Números reales o cero.
// ---------------------------------------------------------------------
router.get(
  '/me',
  authenticate,
  asyncRoute(async (req, res) => {
    const code = await ensureCode(req.user.id);

    const { rows } = await query(
      `select
         count(*) filter (where credited_at is not null)::int as joined,
         count(*) filter (where credited_at is null)::int     as pending
       from referrals where referrer_id = $1`,
      [req.user.id],
    );

    const { rows: cr } = await query(
      `select sims_total, sims_used from referral_credits where user_id = $1`,
      [req.user.id],
    );
    const total = cr[0]?.sims_total ?? 0;
    const used = cr[0]?.sims_used ?? 0;

    res.json({
      code,
      joined: rows[0].joined,       // amigos que entraron y verificaron
      pending: rows[0].pending,     // hicieron clic pero todavía no verificaron
      sims: { total, used, left: total - used },
      per: SIMS_PER_REFERRAL,
    });
  }),
);

// ---------------------------------------------------------------------
// attachReferral(inviteeId, code) — "vengo invitado por este codigo".
//
// NO es un endpoint, y es a proposito. Un endpoint /attach tendria que estar
// autenticado; pero authenticate() exige email verificado, y el attach ocurre
// ANTES de verificar. Peor todavia: si lo abrieramos a usuarios ya verificados,
// cualquiera podria reclamar invitaciones para siempre.
//
// Por eso se llama desde el SIGNUP, que es el unico momento en que sabemos con
// certeza que la persona es nueva. No paga nada: solo deja la deuda anotada.
// ---------------------------------------------------------------------
export const attachReferral = async (inviteeId, rawCode) => {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!looksLikeCode(code)) return { attached: false, reason: 'malformed' };

  const { rows: owner } = await query(`select user_id from referral_codes where code = $1`, [code]);
  if (!owner[0]) return { attached: false, reason: 'unknown_code' };
  // Autoinvitarse es la trampa mas vieja del libro. El CHECK de la tabla ya lo
  // impide; esto solo evita que el CHECK explote como un 500.
  if (owner[0].user_id === inviteeId) return { attached: false, reason: 'self' };

  // `on conflict do nothing` sobre invitee_id: si ya vino invitado por otro, el
  // primero se lo queda. No hay robo de referidos.
  const { rows } = await query(
    `insert into referrals (referrer_id, invitee_id, code)
     values ($1, $2, $3)
     on conflict (invitee_id) do nothing
     returning id`,
    [owner[0].user_id, inviteeId, code],
  );
  return { attached: Boolean(rows[0]), reason: rows[0] ? 'ok' : 'already_invited' };
};

// ---------------------------------------------------------------------
// creditReferral(inviteeId) — se llama UNA vez, desde el flujo de
// verificación de email. Acá es donde se paga.
//
// Todo adentro de una transacción: o cobran los dos, o no cobra ninguno.
// Un referido donde el invitado cobra y el que invitó no, es peor que no
// tener referidos.
// ---------------------------------------------------------------------
export const creditReferral = async (inviteeId) =>
  tx(async (client) => {
    // El `and credited_at is null` es lo que hace esto idempotente: si por lo
    // que sea corre dos veces, la segunda no encuentra fila y no paga nada.
    const { rows } = await client.query(
      `update referrals set credited_at = now()
       where invitee_id = $1 and credited_at is null
       returning referrer_id`,
      [inviteeId],
    );
    if (!rows[0]) return { credited: false };   // no vino invitado, o ya cobró

    const referrerId = rows[0].referrer_id;

    for (const uid of [referrerId, inviteeId]) {
      await client.query(
        `insert into referral_credits (user_id, sims_total)
         values ($1, $2)
         on conflict (user_id) do update
           set sims_total = referral_credits.sims_total + $2,
               updated_at = now()`,
        [uid, SIMS_PER_REFERRAL],
      );
    }

    return { credited: true, referrerId, sims: SIMS_PER_REFERRAL };
  });

/** Consume una simulación regalada. Devuelve false si no le quedan —
 *  y el que llama decide qué hacer, que no es lo mismo que tirar un error. */
export const spendReferralSim = async (userId) => {
  const { rows } = await query(
    `update referral_credits set sims_used = sims_used + 1, updated_at = now()
     where user_id = $1 and sims_used < sims_total
     returning sims_total - sims_used as left`,
    [userId],
  );
  return rows[0] ? { ok: true, left: rows[0].left } : { ok: false, left: 0 };
};

export default referralsRouter;
