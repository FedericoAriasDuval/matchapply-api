import express, { Router } from 'express';
import Stripe from 'stripe';
import { Paddle, Environment } from '@paddle/paddle-node-sdk';
import { config } from '../config.js';
import { query } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { HttpError } from '../middleware/errors.js';

export const billingRouter = Router();

/* Dos proveedores, una sola puerta. BILLING_PROVIDER decide cuál corre.
   Stripe queda de legado (no opera en Argentina); Paddle es el vigente.
   Regla de oro: el tier lo escribe SOLO el webhook tras cobrar, nunca un clic. */
const PROVIDER = config.billing.provider === 'paddle' ? 'paddle' : 'stripe';

const stripe = (PROVIDER === 'stripe' && config.billing.enabled)
  ? new Stripe(config.billing.stripeKey)
  : null;

const paddle = (PROVIDER === 'paddle' && config.billing.enabled)
  ? new Paddle(config.billing.paddleApiKey, {
      environment: config.billing.paddleEnv === 'production' ? Environment.production : Environment.sandbox,
    })
  : null;

const setTier = (userId, tier) => query(`update users set tier = $2 where id = $1`, [userId, tier]);

const upsertSub = (userId, provider, customerId, subscriptionId, status, periodEnd) =>
  query(
    `insert into subscriptions (user_id, provider, customer_id, subscription_id, status, current_period_end)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (user_id) do update set provider = excluded.provider, customer_id = excluded.customer_id,
       subscription_id = excluded.subscription_id, status = excluded.status,
       current_period_end = excluded.current_period_end, updated_at = now()`,
    [userId, provider, customerId, subscriptionId, status, periodEnd],
  );

/** POST /billing/checkout — devuelve la URL de pago del proveedor activo. */
billingRouter.post('/checkout', authenticate, async (req, res, next) => {
  try {
    if (PROVIDER === 'paddle') {
      if (!paddle) throw new HttpError(503, 'billing_disabled', 'Los pagos no están configurados.');
      /* La transacción lleva el userId en customData: así el webhook sabe a quién
         activarle el Pro sin adivinar por email. */
      const txn = await paddle.transactions.create({
        items: [{ priceId: config.billing.paddlePriceId, quantity: 1 }],
        customData: { userId: req.user.id },
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

/* ------------------------------------------------------------------ Paddle */

/* active/trialing = Pro; canceled/paused = free. past_due NO baja el plan:
   Paddle reintenta el cobro y bajarlo ahí castigaría a alguien por un problema
   transitorio de su tarjeta. */
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
    /* El SDK verifica la firma HMAC (Paddle-Signature) con el secreto del webhook
       usando el body CRUDO. Si alguien falsifica el evento, esto lo rechaza. */
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

/* ------------------------------------------------------------------ Stripe */

async function handleStripeWebhook(req, res) {
  if (!stripe) return res.status(503).end();
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.get('stripe-signature'),
      config.billing.webhookSecret,
    );
  } catch (e) {
    return res.status(400).send(`Firma inválida: ${e.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      const userId = s.client_reference_id;
      if (userId) {
        await setTier(userId, 'pro');
        await upsertSub(userId, 'stripe', s.customer, s.subscription, 'active', null);
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
          `update subscriptions set status = $2, current_period_end = to_timestamp($3), updated_at = now()
            where user_id = $1`,
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
 * POST /billing/webhook — única fuente de verdad del tier.
 * Se monta con body RAW (ver server.js) para poder validar la firma.
 */
export const billingWebhook = [
  express.raw({ type: 'application/json' }),
  (req, res) => (PROVIDER === 'paddle' ? handlePaddleWebhook(req, res) : handleStripeWebhook(req, res)),
];
