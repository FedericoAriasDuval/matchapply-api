import express, { Router } from 'express';
import Stripe from 'stripe';
import { Paddle, Environment } from '@paddle/paddle-node-sdk';
import { config } from '../config.js';
import { query } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { webhookLimiter } from '../middleware/rateLimit.js';
import { HttpError } from '../middleware/errors.js';

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
  const m = [];
  if (mpToken && config.billing.mpLifetimeArs > 0) m.push('mercadopago');
  if (paddle && config.billing.paddleLifetimePriceId) m.push('paddle');
  return m;
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
 * POST /billing/checkout — devuelve la URL de pago del método elegido.
 * body.method: 'mercadopago' | 'paddle'. Si no viene, usa el primero disponible.
 */
billingRouter.post('/checkout', authenticate, async (req, res, next) => {
  try {
    const method = String(req.body?.method || '').toLowerCase() || availableMethods()[0];

    if (method === 'mercadopago') {
      if (!mpToken) throw new HttpError(503, 'billing_disabled', 'Mercado Pago no está configurado.');

      /* PAGO ÚNICO de por vida por Mercado Pago: es una PREFERENCE (Checkout Pro),
         NO un preapproval (que es la suscripción mensual). Si no hay monto ARS
         configurado, se RECHAZA — nunca se cae a la suscripción mensual (cobrarle
         una mensualidad a quien pidió el pago único de por vida es el mismo bug
         que ya sacamos con Paddle). El webhook confirma el pago contra la API de
         MP y recién ahí activa el acceso. */
      if (String(req.body?.plan || '').toLowerCase() === 'lifetime') {
        if (!(config.billing.mpLifetimeArs > 0)) {
          throw new HttpError(503, 'billing_disabled', 'El plan de por vida por Mercado Pago todavía no está disponible.');
        }
        const rp = await fetch('https://api.mercadopago.com/checkout/preferences', {
          method: 'POST',
          headers: { Authorization: `Bearer ${mpToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items: [{ title: 'Mavante Pro — de por vida', quantity: 1, unit_price: config.billing.mpLifetimeArs, currency_id: 'ARS' }],
            /* external_reference (userId) va también en el pago: el webhook activa por ahí.
               metadata.plan distingue este pago único de una cuota de la suscripción. */
            external_reference: req.user.id,
            metadata: { plan: 'lifetime' },
            payer: { email: req.user.email },
            back_urls: { success: `${config.appUrl}/#herramientas?upgraded=1` },
            auto_return: 'approved',
            notification_url: `${config.apiUrl}/billing/mp-webhook`,
          }),
        });
        const pref = await rp.json().catch(() => ({}));
        if (!rp.ok || !pref.init_point) {
          console.error('[billing] mp preference (lifetime) fallo:', rp.status, JSON.stringify(pref).slice(0, 300));
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

      /* Dos productos distintos: la suscripción mensual y el pago único.
         Si piden el de por vida y no está configurado, se RECHAZA. Jamás se cae
         al precio mensual: cobrarle 7,99/mes a alguien que pidió un pago único
         de 99 es exactamente el bug que sacamos de la web el 19/07. */
      const deporVida = String(req.body?.plan || '').toLowerCase() === 'lifetime';
      const priceId = deporVida ? config.billing.paddleLifetimePriceId : config.billing.paddlePriceId;
      if (deporVida && !priceId) {
        throw new HttpError(503, 'billing_disabled', 'El plan de por vida todavía no está disponible.');
      }

      /* La transacción lleva el userId en customData: el webhook activa por ahí.
         `plan` viaja también para que el webhook sepa qué se compró sin tener
         que adivinarlo por el precio. */
      const txn = await paddle.transactions.create({
        items: [{ priceId, quantity: 1 }],
        customData: { userId: req.user.id, plan: deporVida ? 'lifetime' : 'monthly' },
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
      const esLifetime = String(pay.metadata?.plan || '').toLowerCase() === 'lifetime';
      if (userId && esLifetime && pay.status === 'approved') {
        await setTier(userId, 'pro');
        await upsertSub(userId, 'mercadopago_lifetime', pay.payer?.id ? String(pay.payer.id) : null, String(pay.id), 'active', null);
        console.log('[billing] plan de por vida (MP) activado para', userId);
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

    /* ── PAGO ÚNICO ("Para siempre") ──────────────────────────────────────────
       Un pago único NO genera eventos subscription.*: genera transaction.*.
       Sin esta rama, alguien pagaba los 99 dólares y no se le activaba nada —
       plata cobrada y producto no entregado, que es la peor falla posible de un
       sistema de pagos.
       Se exige `completed`: `transaction.paid` puede llegar antes de que el
       dinero esté confirmado. */
    if (userId && type === 'transaction.completed' && d.customData?.plan === 'lifetime') {
      await setTier(userId, 'pro');
      await upsertSub(userId, 'paddle_lifetime', d.customerId ?? null, d.id ?? null, 'active', null);
      console.log('[billing] plan de por vida activado para', userId);
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
