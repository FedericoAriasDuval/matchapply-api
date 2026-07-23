import express, { Router } from 'express';
import Stripe from 'stripe';
import { Paddle, Environment } from '@paddle/paddle-node-sdk';
import { config } from '../config.js';
import { query } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { webhookLimiter } from '../middleware/rateLimit.js';
import { HttpError } from '../middleware/errors.js';
import { PROVIDERS_CON_VENCIMIENTO, nuevoVencimiento } from '../lib/tier.js';

export const billingRouter = Router();

/* VARIOS métodos conviven: el usuario elige en el checkout. Cada uno se instancia
   solo si tiene credenciales. Regla de oro: el tier lo escribe SOLO el webhook del
   proveedor tras cobrar, nunca un clic del usuario. */
const paddle = config.billing.paddleEnabled
  ? new Paddle(config.billing.paddleApiKey, {
      environment: config.billing.paddleEnv === 'production' ? Environment.production : Environment.sandbox,
    })
  : null;
const mpToken = config.billing.mpEnabled ? config.billing.mpAccessToken : null;
const stripe = config.billing.stripeKey ? new Stripe(config.billing.stripeKey) : null;

/** Métodos de pago disponibles para el frontend, en orden de preferencia. */
/* ¿Se puede vender el plan de por vida? Solo si Paddle esta configurado Y
   existe el precio de pago unico. El frontend usa esto para NO dibujar una
   tarjeta que lleva a un checkout que no existe. */
export function lifetimeAvailable() {
  return lifetimeMethods().length > 0;
}
/* Métodos que pueden cobrar el pago ÚNICO de por vida. El front usa esto para
   dibujar en la tarjeta Lifetime solo los botones que de verdad cobran. */
export function lifetimeMethods() {
  return unicoMethods('lifetime');
}

/* ── Planes de PAGO ÚNICO (no son suscripción) ───────────────────────────────
   Los dos se cobran igual —una preference de MP o una transacción de Paddle—
   y solo cambian precio, título y qué acceso otorga el webhook:
     · lifetime → Pro para siempre.
     · week     → Pro por 7 días, y se apaga SOLO (ver lib/tier.js).
   Tenerlos en una tabla evita duplicar el bloque de checkout por cada plan. */
export const PAGO_UNICO = {
  lifetime: {
    titulo: 'Mavante Pro — de por vida',
    ars: () => config.billing.mpLifetimeArs,
    priceId: () => config.billing.paddleLifetimePriceId,
    /* null = sin vencimiento */
    diasDeAcceso: null,
  },
  week: {
    titulo: 'Mavante Pro — pase semanal (7 días)',
    ars: () => config.billing.mpWeekArs,
    priceId: () => config.billing.paddleWeekPriceId,
    diasDeAcceso: 7,
  },
};

/** Métodos que pueden cobrar un plan de pago único concreto. */
export function unicoMethods(plan) {
  const p = PAGO_UNICO[plan];
  if (!p) return [];
  const m = [];
  if (mpToken && p.ars() > 0) m.push('mercadopago');
  if (paddle && p.priceId()) m.push('paddle');
  return m;
}

/** ¿Se puede vender el pase semanal? Lo usa el front para no dibujar de más. */
export function weekMethods() {
  return unicoMethods('week');
}

export function availableMethods() {
  const m = [];
  if (mpToken) m.push('mercadopago');
  if (paddle) m.push('paddle');
  if (!m.length && stripe) m.push('stripe');
  return m;
}

const setTier = (userId, tier) => query(`update users set tier = $2 where id = $1`, [userId, tier]);

/* ¿Esta persona compró el plan de POR VIDA?
   Se marca con `provider = 'paddle_lifetime'` en la fila de subscriptions, y NO
   con una columna nueva. El motivo es concreto: una columna nueva obliga a una
   migración, y el código y la migración no viajan juntos en el mismo deploy —
   eso ya rompió producción una vez (ver 005). Esta forma funciona con el esquema
   que YA existe, así que no hay ventana en la que el código pida algo que la
   base todavía no tiene. */
const esDePorVida = async (userId) => {
  const { rows } = await query(`select provider from subscriptions where user_id = $1`, [userId]);
  const p = rows[0]?.provider;
  return p === 'paddle_lifetime' || p === 'mercadopago_lifetime';
};

/* Estados en los que una suscripción todavía da acceso. past_due entra a
   propósito: el proveedor sigue reintentando el cobro (mismo criterio que
   paddleDeactivates). */
const ESTADOS_VIVOS = new Set(['active', 'trialing', 'authorized', 'past_due']);

const upsertSub = (userId, provider, customerId, subscriptionId, status, periodEnd) =>
  query(
    `insert into subscriptions (user_id, provider, customer_id, subscription_id, status, current_period_end)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (user_id) do update set provider = excluded.provider, customer_id = excluded.customer_id,
       subscription_id = excluded.subscription_id, status = excluded.status,
       current_period_end = excluded.current_period_end, updated_at = now()`,
    [userId, provider, customerId, subscriptionId, status, periodEnd],
  );

/**
 * Otorga un plan de pago único ya COBRADO (lo llaman los dos webhooks).
 *
 * La tabla subscriptions tiene UNA fila por usuario, y de ahí salen las dos
 * reglas que este helper protege:
 *   1. Un pase de 7 días NO puede pisar un acceso mayor. Si alguien con la
 *      mensual viva —o con el de por vida— compra un pase, escribir la fila del
 *      pase le pondría fecha de muerte a los 7 días a un acceso que no la tenía.
 *      En ese caso se le deja el acceso grande y no se toca la fila.
 *   2. Un pase que se renueva SUMA sobre lo que queda (ver nuevoVencimiento).
 */
async function otorgarPagoUnico({ userId, plan, proveedor, customerId, refId }) {
  const unico = PAGO_UNICO[plan];
  if (!unico) return;
  const { rows } = await query(
    `select provider, status, current_period_end from subscriptions where user_id = $1`,
    [userId],
  );
  const actual = rows[0];
  const prov = actual?.provider;
  const dePorVida = prov === 'paddle_lifetime' || prov === 'mercadopago_lifetime';
  const recurrenteViva =
    Boolean(prov) && !dePorVida && !PROVIDERS_CON_VENCIMIENTO.has(prov) &&
    ESTADOS_VIVOS.has(String(actual.status || '').toLowerCase());

  if (unico.diasDeAcceso && (dePorVida || recurrenteViva)) {
    await setTier(userId, 'pro');
    console.warn(`[billing] ${plan} cobrado a ${userId} que ya tenía un acceso mayor (${prov}): no se pisa la fila`);
    return;
  }

  const hasta = nuevoVencimiento(unico.diasDeAcceso, actual?.current_period_end);
  await setTier(userId, 'pro');
  await upsertSub(userId, `${proveedor}_${plan}`, customerId ?? null, refId ?? null, 'active', hasta);
  console.log(`[billing] ${plan} (${proveedor}) activado para`, userId, hasta ? `hasta ${hasta.toISOString()}` : '(sin vencimiento)');
}

/**
 * POST /billing/checkout — devuelve la URL de pago del método elegido.
 * body.method: 'mercadopago' | 'paddle'. Si no viene, usa el primero disponible.
 */
billingRouter.post('/checkout', authenticate, async (req, res, next) => {
  try {
    const method = String(req.body?.method || '').toLowerCase() || availableMethods()[0];

    if (method === 'mercadopago') {
      if (!mpToken) throw new HttpError(503, 'billing_disabled', 'Mercado Pago no está configurado.');

      /* PAGO ÚNICO (de por vida o pase semanal) por Mercado Pago: es una
         PREFERENCE (Checkout Pro), NO un preapproval (que es la suscripción
         mensual). Si no hay monto ARS configurado para ESE plan, se RECHAZA —
         nunca se cae a la mensual (cobrarle una mensualidad a quien pidió un pago
         único es el mismo bug que ya sacamos con Paddle). El webhook confirma el
         pago contra la API de MP y recién ahí activa el acceso. */
      const planUnico = String(req.body?.plan || '').toLowerCase();
      const unico = PAGO_UNICO[planUnico];
      if (unico) {
        const monto = unico.ars();
        if (!(monto > 0)) {
          throw new HttpError(503, 'billing_disabled', 'Ese plan todavía no está disponible por Mercado Pago.');
        }
        const rp = await fetch('https://api.mercadopago.com/checkout/preferences', {
          method: 'POST',
          headers: { Authorization: `Bearer ${mpToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items: [{ title: unico.titulo, quantity: 1, unit_price: monto, currency_id: 'ARS' }],
            /* external_reference (userId) va también en el pago: el webhook activa por ahí.
               metadata.plan distingue ESTE pago único de una cuota de la suscripción,
               y le dice al webhook cuánto acceso otorgar. */
            external_reference: req.user.id,
            metadata: { plan: planUnico },
            payer: { email: req.user.email },
            back_urls: { success: `${config.appUrl}/#herramientas?upgraded=1` },
            auto_return: 'approved',
            notification_url: `${config.apiUrl}/billing/mp-webhook`,
          }),
        });
        const pref = await rp.json().catch(() => ({}));
        if (!rp.ok || !pref.init_point) {
          console.error(`[billing] mp preference (${planUnico}) fallo:`, rp.status, JSON.stringify(pref).slice(0, 300));
          throw new HttpError(502, 'billing_no_url', 'No se pudo iniciar el pago con Mercado Pago.');
        }
        return res.json({ url: pref.init_point });
      }

      /* Suscripción de MP (preapproval). external_reference lleva el userId: así el
         webhook sabe a quién activarle el Pro. La plata la cobra MP en pesos. */
      const r = await fetch('https://api.mercadopago.com/preapproval', {
        method: 'POST',
        headers: { Authorization: `Bearer ${mpToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: 'Mavante Pro',
          external_reference: req.user.id,
          payer_email: req.user.email,
          back_url: `${config.appUrl}/#herramientas?upgraded=1`,
          notification_url: `${config.apiUrl}/billing/mp-webhook`,
          auto_recurring: {
            frequency: 1,
            frequency_type: 'months',
            transaction_amount: config.billing.mpPriceArs,
            currency_id: 'ARS',
          },
          status: 'pending',
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.init_point) {
        console.error('[billing] mp preapproval fallo:', r.status, JSON.stringify(data).slice(0, 300));
        throw new HttpError(502, 'billing_no_url', 'No se pudo iniciar el pago con Mercado Pago.');
      }
      return res.json({ url: data.init_point });
    }

    if (method === 'paddle') {
      if (!paddle) throw new HttpError(503, 'billing_disabled', 'Los pagos con tarjeta no están configurados.');

      /* Tres productos: la suscripción mensual y los dos pagos únicos (de por
         vida y pase semanal). Si piden un pago único que no está configurado, se
         RECHAZA. Jamás se cae al precio mensual: cobrarle 7,99/mes a alguien que
         pidió un pago único es exactamente el bug que sacamos de la web el 19/07. */
      const planPedido = String(req.body?.plan || '').toLowerCase();
      const unicoPaddle = PAGO_UNICO[planPedido];
      const priceId = unicoPaddle ? unicoPaddle.priceId() : config.billing.paddlePriceId;
      if (unicoPaddle && !priceId) {
        throw new HttpError(503, 'billing_disabled', 'Ese plan todavía no está disponible con tarjeta.');
      }

      /* La transacción lleva el userId en customData: el webhook activa por ahí.
         `plan` viaja también para que el webhook sepa qué se compró (y cuánto
         acceso otorgar) sin tener que adivinarlo por el precio. */
      const txn = await paddle.transactions.create({
        items: [{ priceId, quantity: 1 }],
        customData: { userId: req.user.id, plan: unicoPaddle ? planPedido : 'monthly' },
      });
      const base = config.billing.paddleCheckoutUrl;
      const url =
        txn?.checkout?.url ||
        (base ? `${base}${base.includes('?') ? '&' : '?'}_ptxn=${txn.id}` : null);
      if (!url) throw new HttpError(502, 'billing_no_url', 'No se pudo iniciar el pago.');
      return res.json({ url });
    }

    // Stripe (legado)
    if (!stripe) throw new HttpError(503, 'billing_disabled', 'Los pagos no están configurados.');
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: req.user.email,
      client_reference_id: req.user.id,
      line_items: [{ price: config.billing.pricePro, quantity: 1 }],
      success_url: `${config.appUrl}/#herramientas/cv-a-medida?upgraded=1`,
      cancel_url: `${config.appUrl}/#herramientas`,
    });
    res.json({ url: session.url });
  } catch (e) {
    next(e);
  }
});

/* ═══════════════════════════════ Mercado Pago ═══════════════════════════════ */

/**
 * POST /billing/mp-webhook — aviso de MP. NO confía en el body: usa el id como
 * disparador y RE-CONSULTA el preapproval a la API de MP (fuente autoritativa),
 * así un aviso falsificado no puede activar un Pro.
 * Se monta dentro del router (body JSON ya parseado por el server).
 */
billingRouter.post('/mp-webhook', webhookLimiter, async (req, res) => {
  if (!mpToken) return res.sendStatus(503);
  try {
    const type = String(req.query.type || req.query.topic || req.body?.type || req.body?.action || '');
    const id = req.query['data.id'] || req.query.id || req.body?.data?.id;
    if (id && /preapproval|subscription/i.test(type)) {
      const r = await fetch(`https://api.mercadopago.com/preapproval/${id}`, {
        headers: { Authorization: `Bearer ${mpToken}` },
      });
      if (!r.ok) return res.sendStatus(502);  // transitorio → MP reintenta
      const pre = await r.json();
      const userId = pre.external_reference;
      if (userId) {
        const active = pre.status === 'authorized';
        await setTier(userId, active ? 'pro' : 'free');
        await upsertSub(userId, 'mercadopago', pre.payer_id ? String(pre.payer_id) : null, pre.id, pre.status ?? 'pending', null);
      }
    } else if (id && /payment/i.test(type)) {
      /* PAGO ÚNICO de por vida (Checkout Pro). Se re-consulta a la API de MP
         (fuente autoritativa): un aviso falsificado no puede activar nada. Solo
         un pago APROBADO y marcado como lifetime en metadata acredita el acceso.
         Una cuota de la suscripción mensual NO trae metadata.plan=lifetime, así
         que este camino no la toca. */
      const r = await fetch(`https://api.mercadopago.com/v1/payments/${id}`, {
        headers: { Authorization: `Bearer ${mpToken}` },
      });
      if (!r.ok) return res.sendStatus(502);   // transitorio → MP reintenta
      const pay = await r.json();
      const userId = pay.external_reference;
      const plan = String(pay.metadata?.plan || '').toLowerCase();
      const unico = PAGO_UNICO[plan];
      if (userId && unico && pay.status === 'approved') {
        /* El acceso CON vencimiento (pase semanal) se anota en
           current_period_end, y lib/tier.js lo hace cumplir en cada request.
           El de por vida va sin fecha: no vence nunca. */
        await otorgarPagoUnico({
          userId,
          plan,
          proveedor: 'mercadopago',
          customerId: pay.payer?.id ? String(pay.payer.id) : null,
          refId: String(pay.id),
        });
      }
    }
    res.sendStatus(200);
  } catch (e) {
    console.error('[billing] mp webhook:', e.message);
    res.sendStatus(500);  // MP reintenta ante error real
  }
});

/* ═══════════════════════════════ Paddle ═══════════════════════════════ */

/* active/trialing = Pro; canceled/paused = free. past_due NO baja el plan:
   Paddle reintenta el cobro y bajarlo ahí castigaría por un problema transitorio. */
const paddleActivates = (type, status) =>
  type === 'subscription.activated' ||
  type === 'subscription.created' ||
  type === 'subscription.resumed' ||
  (type === 'subscription.updated' && (status === 'active' || status === 'trialing'));

const paddleDeactivates = (type, status) =>
  type === 'subscription.canceled' ||
  type === 'subscription.paused' ||
  (type === 'subscription.updated' && status !== 'active' && status !== 'trialing' && status !== 'past_due');

async function handlePaddleWebhook(req, res) {
  if (!paddle) return res.status(503).end();
  let event;
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : req.body;
    event = await paddle.webhooks.unmarshal(raw, config.billing.paddleWebhookSecret, req.get('paddle-signature'));
  } catch (e) {
    return res.status(400).send(`Firma inválida: ${e.message}`);
  }
  try {
    const type = event.eventType;
    const d = event.data || {};
    const userId = d.customData?.userId;
    const status = d.status;
    const periodEnd = d.currentBillingPeriod?.endsAt ?? null;

    /* ── PAGO ÚNICO (de por vida o pase semanal) ──────────────────────────────
       Un pago único NO genera eventos subscription.*: genera transaction.*.
       Sin esta rama, alguien pagaba y no se le activaba nada — plata cobrada y
       producto no entregado, que es la peor falla posible de un sistema de pagos.
       Se exige `completed`: `transaction.paid` puede llegar antes de que el
       dinero esté confirmado. */
    const planPaddle = String(d.customData?.plan || '').toLowerCase();
    const unicoPaddle = PAGO_UNICO[planPaddle];
    if (userId && type === 'transaction.completed' && unicoPaddle) {
      await otorgarPagoUnico({
        userId,
        plan: planPaddle,
        proveedor: 'paddle',
        customerId: d.customerId,
        refId: d.id,
      });
      return res.json({ received: true });
    }

    /* Cualquier evento de suscripción que llegue para alguien que ya compró el
       plan de por vida se IGNORA. Si no, una cancelación vieja —o una prueba en
       sandbox— le bajaría el plan a alguien que pagó para siempre. "Para
       siempre" tiene que aguantar incluso nuestros propios errores. */
    if (userId && (await esDePorVida(userId))) {
      console.log('[billing] evento', type, 'ignorado: el usuario tiene plan de por vida');
      return res.json({ received: true });
    }

    if (userId && paddleActivates(type, status)) {
      await setTier(userId, 'pro');
      await upsertSub(userId, 'paddle', d.customerId ?? null, d.id ?? null, status ?? 'active', periodEnd);
    } else if (userId && paddleDeactivates(type, status)) {
      await setTier(userId, 'free');
      await upsertSub(userId, 'paddle', d.customerId ?? null, d.id ?? null, status ?? 'canceled', periodEnd);
    }
    res.json({ received: true });
  } catch (e) {
    console.error('[billing] paddle webhook:', e.message);
    res.status(500).end();
  }
}

/* ═══════════════════════════════ Stripe (legado) ═══════════════════════════════ */

async function handleStripeWebhook(req, res) {
  if (!stripe) return res.status(503).end();
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), config.billing.webhookSecret);
  } catch (e) {
    return res.status(400).send(`Firma inválida: ${e.message}`);
  }
  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      if (s.client_reference_id) {
        await setTier(s.client_reference_id, 'pro');
        await upsertSub(s.client_reference_id, 'stripe', s.customer, s.subscription, 'active', null);
      }
    }
    if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const { rows } = await query(`select user_id from subscriptions where subscription_id = $1`, [sub.id]);
      const userId = rows[0]?.user_id;
      if (userId) {
        const active = sub.status === 'active' || sub.status === 'trialing';
        await setTier(userId, active ? 'pro' : 'free');
        await query(
          `update subscriptions set status = $2, current_period_end = to_timestamp($3), updated_at = now() where user_id = $1`,
          [userId, sub.status, sub.current_period_end ?? null],
        );
      }
    }
    res.json({ received: true });
  } catch (e) {
    console.error('[billing] webhook:', e.message);
    res.status(500).end();
  }
}

/**
 * POST /billing/webhook — webhook con firma (Paddle/Stripe). Body RAW (ver server.js).
 * Mercado Pago usa /billing/mp-webhook (JSON) porque no firma igual.
 */
export const billingWebhook = [
  express.raw({ type: 'application/json' }),
  (req, res) => (paddle ? handlePaddleWebhook(req, res) : handleStripeWebhook(req, res)),
];
