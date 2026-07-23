import express, { Router } from 'express';
import Stripe from 'stripe';
import { z } from 'zod';
import { Paddle, Environment } from '@paddle/paddle-node-sdk';
import { config } from '../config.js';
import { query } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { licenseLimiter, webhookLimiter } from '../middleware/rateLimit.js';
import { HttpError } from '../middleware/errors.js';
import {
  ESTADOS_VIVOS, PROVIDERS_CON_VENCIMIENTO, PROVIDERS_DE_POR_VIDA,
  bloqueoDeCompra, debeCancelarRecurrente, nuevoVencimiento, recurrenteViva,
} from '../lib/tier.js';
import { motivoDeRechazo, normalizarCodigo } from '../lib/orgLicense.js';

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
  return PROVIDERS_DE_POR_VIDA.has(rows[0]?.provider);
};

const upsertSub =(userId, provider, customerId, subscriptionId, status, periodEnd) =>
  query(
    `insert into subscriptions (user_id, provider, customer_id, subscription_id, status, current_period_end)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (user_id) do update set provider = excluded.provider, customer_id = excluded.customer_id,
       subscription_id = excluded.subscription_id, status = excluded.status,
       current_period_end = excluded.current_period_end, updated_at = now()`,
    [userId, provider, customerId, subscriptionId, status, periodEnd],
  );

/**
 * Da de baja el débito mensual en el proveedor. Best-effort A PROPÓSITO: la
 * persona YA pagó el de por vida, así que un error del proveedor no puede
 * impedirle recibir lo que compró. Pero se loguea fuerte, porque si esto falla
 * le sigue entrando el cobro todos los meses y eso hay que arreglarlo A MANO.
 */
async function cancelarRecurrente(provider, subscriptionId, userId) {
  try {
    if (provider === 'mercadopago' && mpToken) {
      const r = await fetch(`https://api.mercadopago.com/preapproval/${subscriptionId}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${mpToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'cancelled' }),
      });
      if (!r.ok) throw new Error(`MP respondió ${r.status}`);
    } else if (provider === 'paddle' && paddle) {
      await paddle.subscriptions.cancel(subscriptionId, { effectiveFrom: 'immediately' });
    } else if (provider === 'stripe' && stripe) {
      await stripe.subscriptions.cancel(subscriptionId);
    } else {
      console.warn('[billing] no se pudo cancelar', provider, '(proveedor sin configurar)');
      return;
    }
    console.log('[billing] débito mensual dado de baja para', userId, `(${provider} ${subscriptionId})`);
  } catch (e) {
    console.error(
      `[billing] ATENCIÓN: ${userId} compró el plan de por vida y NO se pudo cancelar su ` +
      `suscripción ${provider} ${subscriptionId}: ${e.message}. Le va a seguir entrando el cobro ` +
      `mensual — hay que cancelarlo a mano en el panel del proveedor.`,
    );
  }
}

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
    `select provider, status, subscription_id, current_period_end from subscriptions where user_id = $1`,
    [userId],
  );
  const actual = rows[0];
  const prov = actual?.provider;
  const dePorVida = PROVIDERS_DE_POR_VIDA.has(prov);
  const mensualViva =
    Boolean(prov) && !dePorVida && !PROVIDERS_CON_VENCIMIENTO.has(prov) &&
    ESTADOS_VIVOS.has(String(actual.status || '').toLowerCase());

  /* Se pasó al de por vida teniendo la mensual: se le da de baja el débito. Si
     no, pagaría el plan definitivo y le seguiría entrando el cobro todos los
     meses. Va ANTES de escribir la fila porque después se pierde el id de la
     suscripción que hay que cancelar. */
  if (debeCancelarRecurrente(actual, plan)) {
    await cancelarRecurrente(actual.provider, actual.subscription_id, userId);
  }

  if (unico.diasDeAcceso && (dePorVida || mensualViva)) {
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

    /* NADIE PAGA DOS VECES LO MISMO. El front ya no dibuja el botón cuando la
       persona es Pro, pero la decisión de cobrar no puede vivir en un botón: un
       enlace viejo, dos pestañas abiertas o un doble clic llegan igual hasta acá.
       El único plan que un Pro puede comprar es el de por vida, que no es comprar
       de nuevo sino cambiar de forma de pagar — y al activarse le damos de baja
       la mensual (ver otorgarPagoUnico). */
    const { rows: acceso } = await query(
      `select provider as sub_provider, current_period_end as sub_until, status
         from subscriptions where user_id = $1`,
      [req.user.id],
    );
    const bloqueo = bloqueoDeCompra(
      { tier: req.user.tier, ...(acceso[0] ?? {}) },
      String(req.body?.plan || 'monthly').toLowerCase(),
    );
    if (bloqueo) throw new HttpError(409, bloqueo.code, bloqueo.message);

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

/**
 * POST /billing/redeem  { code }  — canje de una licencia institucional.
 *
 * Es el ÚNICO camino por el que un clic del usuario activa Pro, y no rompe la
 * regla de oro (el tier lo escribe quien cobró): acá ya cobramos, por afuera y
 * por adelantado, a la institución. El código no es una promesa de pago, es el
 * comprobante de uno que ya ocurrió.
 *
 * Lo que sí se cuida: quién puede usarlo (dominio de mail), cuántos (cupo) y
 * hasta cuándo (la fecha del contrato, que hace cumplir lib/tier.js).
 */
billingRouter.post('/redeem', authenticate, licenseLimiter, async (req, res, next) => {
  try {
    const { code } = z.object({ code: z.string().trim().min(3).max(64) }).parse(req.body);
    const codigo = normalizarCodigo(code);

    /* Si ya está pagando Pro por su cuenta, canjear le haría GASTAR un cupo de la
       institución sin ganar nada — y peor: la fila de suscripción (una por
       usuario) pasaría a ser la de la licencia y perderíamos el id del débito que
       le sigue entrando. Se le dice que no hace falta, que es la verdad. */
    const { rows: yaTiene } = await query(
      `select provider, status from subscriptions where user_id = $1`,
      [req.user.id],
    );
    const suyo = yaTiene[0];
    if (req.user.tier === 'pro' && (PROVIDERS_DE_POR_VIDA.has(suyo?.provider) || recurrenteViva(suyo))) {
      throw new HttpError(409, 'already_pro',
        'Ya tenés Mavante Pro con tu propia suscripción, así que no necesitás canjear el código. Si querés usar el de tu institución y dar de baja el tuyo, escribinos a support@mavante.com.');
    }

    const { rows: lics } = await query(
      `select id, code, name, email_domain, max_users, valid_until, is_active
         from org_licenses where upper(code) = $1`,
      [codigo],
    );
    const lic = lics[0] ?? null;

    /* Cupo y pertenencia se consultan juntos: si ya sos miembro, volver a canjear
       el mismo código no puede fallar por cupo lleno (sos uno de los que lo
       llenan). Pasa de verdad — la gente reintenta cuando no ve el cambio. */
    const { rows: cuenta } = lic
      ? await query(
          `select count(*)::int as usados,
                  count(*) filter (where user_id = $2)::int as mio
             from org_license_members where license_id = $1`,
          [lic.id, req.user.id],
        )
      : [{ usados: 0, mio: 0 }];

    const rechazo = motivoDeRechazo(lic, {
      usados: cuenta[0].usados,
      email: req.user.email,
      yaEsMiembro: cuenta[0].mio > 0,
    });
    if (rechazo) throw new HttpError(400, rechazo.code, rechazo.message);

    /* Una persona ocupa UN cupo en UNA licencia (unique en user_id). Si ya está
       en otra, el insert no hace nada y hay que decirlo: quedarse callado le
       haría creer que canjeó algo que no canjeó. */
    const { rows: alta } = await query(
      `insert into org_license_members (license_id, user_id) values ($1, $2)
       on conflict do nothing returning license_id`,
      [lic.id, req.user.id],
    );
    if (!alta[0] && cuenta[0].mio === 0) {
      throw new HttpError(400, 'license_other', 'Tu cuenta ya está usando otra licencia institucional.');
    }

    await setTier(req.user.id, 'pro');
    await upsertSub(req.user.id, 'org_license', null, lic.id, 'active', lic.valid_until);
    console.log('[billing] licencia', lic.code, 'canjeada por', req.user.id);

    res.json({
      ok: true,
      organization: lic.name,
      until: lic.valid_until,
      /* El front lo usa para actualizar el plan sin esperar al próximo /me. */
      tier: 'pro',
    });
  } catch (e) {
    next(e instanceof z.ZodError ? new HttpError(400, 'invalid_payload', 'Escribí el código que te dieron.') : e);
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
        /* Misma guarda que en Paddle, y acá es todavía más necesaria: cuando
           alguien se pasa al plan de por vida le DAMOS DE BAJA la mensual, y esa
           baja vuelve como este mismo aviso. Sin la guarda, el sistema le sacaría
           el Pro a alguien treinta segundos después de venderle el acceso
           definitivo. "Para siempre" tiene que aguantar nuestros propios actos. */
        if (await esDePorVida(userId)) {
          console.log('[billing] aviso de MP', pre.status, 'ignorado: el usuario tiene plan de por vida');
        } else {
          const active = pre.status === 'authorized';
          await setTier(userId, active ? 'pro' : 'free');
          await upsertSub(userId, 'mercadopago', pre.payer_id ? String(pre.payer_id) : null, pre.id, pre.status ?? 'pending', null);
        }
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
