/**
 * src/lib/planCatalog.js
 *
 * El catálogo de las suscripciones nuevas: 2 planes (plus, pro) × 2 períodos
 * (mensual, anual). Módulo PURO —sin config, sin red, sin base—: recibe los precios
 * como argumento, así se testea en aislamiento (importar billing.js arrastra los SDK
 * de pago y las credenciales). Los precios reales viven en env (config.billing) y se
 * los pasa billing.js.
 *
 * La CLAVE de cada plan es `${tier}_${period}` — 'plus_monthly', 'pro_annual'… — y es
 * la misma para el catálogo de Paddle (price ids) y el de Mercado Pago (montos ARS).
 *
 * Regla de oro intacta: acá NO se cobra ni se activa nada. Esto solo dice "qué precio
 * corresponde a qué plan" y "qué tier otorga tal price id". El tier lo sigue escribiendo
 * el webhook tras cobrar (ver billing.js / lib/tier.js).
 */

/** Los tiers que se pagan (los que este catálogo cubre). Free no se compra. */
export const esTierPago = (t) => t === 'plus' || t === 'pro';

/** Períodos válidos de facturación. */
export const esPeriodo = (p) => p === 'monthly' || p === 'annual';

/** La clave del plan en los catálogos. Normaliza: período desconocido → mensual. */
export const claveSub = (tier, period) => `${tier}_${period === 'annual' ? 'annual' : 'monthly'}`;

/**
 * Price id de Paddle para (tier, period). '' si ese plan no está configurado — y
 * ese '' es a propósito: sin price, billing.js RECHAZA el checkout en vez de caer a
 * otro precio (cobrarle a alguien algo distinto de lo que pidió es el bug que ya
 * sacamos con el pago único).
 * @param {Record<string,string>} catalogo  { plus_monthly:'pri_...', ... }
 */
export const paddlePriceSub = (catalogo, tier, period) =>
  (catalogo && catalogo[claveSub(tier, period)]) || '';

/**
 * El tier que otorga un price id de Paddle (mapa inverso), para que el WEBHOOK sepa
 * qué plan activar según qué se compró. null si el price no está en el catálogo:
 * el webhook cae entonces al default (Pro), que respeta el grandfathering de los
 * suscriptores viejos (que no tienen price en este catálogo nuevo).
 * @param {Record<string,string>} catalogo
 */
export const tierDePaddlePrice = (catalogo, priceId) => {
  if (!priceId || !catalogo) return null;
  for (const clave of Object.keys(catalogo)) {
    if (catalogo[clave] && catalogo[clave] === priceId) return clave.split('_')[0];
  }
  return null;
};

/**
 * Monto ARS de Mercado Pago para (tier, period). 0 = no configurado → billing.js
 * rechaza (mismo criterio que Paddle: no se inventa un precio).
 * @param {Record<string,number>} catalogoArs
 */
export const mpMontoSub = (catalogoArs, tier, period) =>
  Number((catalogoArs && catalogoArs[claveSub(tier, period)]) || 0);

/**
 * La cadencia de cobro de Mercado Pago según el período. MP expresa el anual como
 * "cada 12 meses" (frequency_type sólo admite 'months'/'days'): un preapproval con
 * frequency 12 months cobra una vez por año, que es exactamente el plan anual.
 */
export const frecuenciaMp = (period) =>
  period === 'annual' ? { frequency: 12, frequency_type: 'months' } : { frequency: 1, frequency_type: 'months' };

/**
 * El tier que otorga una suscripción de Mercado Pago, leído del external_reference
 * ('userId|tier'). Los suscriptores VIEJOS mandan sólo 'userId' (sin tier) → cae al
 * default 'pro': eso ES el grandfathering (quedan en Pro, sin migración destructiva).
 * @param {string} planRef  el campo `plan` que devuelve parseRefMp
 */
export const tierDeRefMp = (planRef) => (esTierPago(planRef) ? planRef : 'pro');

/**
 * El tier de una CUOTA recurrente de Mercado Pago. El PAGO suelto no siempre trae el
 * external_reference con el tier (MP no lo copia de forma confiable a los pagos que
 * genera un preapproval), así que se acepta un `hint` tomado del authorized_payment
 * o del preapproval, que SÍ lo llevan. Prioridad: el ref del pago → el hint → 'pro'
 * (grandfathering del suscriptor viejo sin tier). NUNCA sube/baja el plan por una
 * cuota: sólo reafirma el tier que ya se fijó al activar la suscripción.
 */
export const tierPagoRecurrente = (planPago, hint) =>
  esTierPago(planPago) ? planPago : (esTierPago(hint) ? hint : 'pro');
