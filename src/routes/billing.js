import express, { Router } from 'express';
import Stripe from 'stripe';
import { config } from '../config.js';
import { query } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { HttpError } from '../middleware/errors.js';

export const billingRouter = Router();

const stripe = config.billing.enabled ? new Stripe(config.billing.stripeKey) : null;

/** POST /billing/checkout — devuelve la URL de pago de Stripe. */
billingRouter.post('/checkout', authenticate, async (req, res, next) => {
  try {
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

/**
 * POST /billing/webhook — única fuente de verdad del tier.
 * Se monta con body RAW (ver server.js) para poder validar la firma.
 */
export const billingWebhook = [
  express.raw({ type: 'application/json' }),
  async (req, res) => {
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

    const setTier = async (userId, tier) =>
      query(`update users set tier = $2 where id = $1`, [userId, tier]);

    try {
      if (event.type === 'checkout.session.completed') {
        const s = event.data.object;
        const userId = s.client_reference_id;
        if (userId) {
          await setTier(userId, 'pro');
          await query(
            `insert into subscriptions (user_id, provider, customer_id, subscription_id, status)
             values ($1, 'stripe', $2, $3, 'active')
             on conflict (user_id) do update set customer_id = excluded.customer_id,
               subscription_id = excluded.subscription_id, status = 'active', updated_at = now()`,
            [userId, s.customer, s.subscription],
          );
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
  },
];
