/**
 * src/lib/tier.js
 *
 * El plan EFECTIVO de una cuenta, que no siempre es el que dice users.tier.
 *
 * Hasta acá "sos Pro o no sos Pro": una columna, sin noción de hasta cuándo. El
 * pase semanal (y las licencias institucionales) rompen eso: son accesos con
 * vencimiento DURO que NO se auto-renuevan. Pasada la fecha, la persona vuelve a
 * free aunque la columna siga diciendo 'pro'. La fecha la escribe el webhook que
 * otorga el acceso, en subscriptions.current_period_end.
 *
 * QUÉ NO ENTRA ACÁ, a propósito:
 *   - La suscripción MENSUAL. Su vigencia la maneja el webhook del proveedor.
 *     Si la bajáramos localmente por una fecha vencida, un aviso demorado de
 *     Mercado Pago le cortaría el Pro a alguien que pagó. Es la misma razón por
 *     la que billing.js decide que `past_due` NO baja el plan.
 *   - El plan de por vida. No vence: ese es todo el punto.
 *
 * Regla de oro intacta: el tier lo ESCRIBE el webhook tras cobrar. Acá solo se
 * LEE, y se le aplica el vencimiento que el propio webhook dejó anotado.
 */

/** Proveedores cuyo acceso caduca solo, sin renovación. */
export const PROVIDERS_CON_VENCIMIENTO = new Set([
  'mercadopago_week',
  'paddle_week',
  'org_license',
]);

/** El acceso que no vence nunca porque se pagó una vez y para siempre. */
export const PROVIDERS_DE_POR_VIDA = new Set(['mercadopago_lifetime', 'paddle_lifetime']);

/** Estados en los que una suscripción todavía da acceso. past_due entra a
    propósito: el proveedor sigue reintentando el cobro, y bajarla ahí castigaría
    por un problema transitorio. */
export const ESTADOS_VIVOS = new Set(['active', 'trialing', 'authorized', 'past_due']);

/** ¿Este proveedor cobra TODOS los meses? (lo contrario del pago único) */
export const esRecurrente = (provider) =>
  provider === 'mercadopago' || provider === 'paddle' || provider === 'stripe';

/** ¿La suscripción de esta fila se sigue cobrando ahora mismo? */
export const recurrenteViva = (fila) =>
  Boolean(fila) && esRecurrente(fila.provider) && ESTADOS_VIVOS.has(String(fila.status || '').toLowerCase());

/**
 * ¿Puede esta persona COMPRAR este plan? Devuelve null si sí, o { code, message }.
 *
 * La regla que gobierna: nadie paga dos veces por lo mismo. Alguien que ya tiene
 * Pro no puede comprar Pro otra vez —ni la mensual ni el pase semanal—, porque
 * lo único que consigue es que le cobren dos veces por el mismo acceso. Lo que
 * SÍ puede es pasarse al de por vida, que no es comprar de nuevo: es cambiar de
 * forma de pagar, y al activarse le damos de baja la mensual.
 *
 * @param {{tier?:string, sub_provider?:string|null, sub_until?:Date|string|null}} u  la cuenta
 * @param {string} plan  '' | 'monthly' | 'week' | 'lifetime'
 */
export const bloqueoDeCompra = (u, plan) => {
  const pedido = String(plan || 'monthly').toLowerCase() || 'monthly';
  const esPro = tierEfectivo(u) === 'pro';
  if (!esPro) return null;                     // sin Pro, se puede comprar todo

  const proveedor = u?.sub_provider ?? null;

  if (pedido === 'lifetime') {
    /* Ya lo tiene: no hay nada arriba de "para siempre" que venderle. */
    if (PROVIDERS_DE_POR_VIDA.has(proveedor)) {
      return { code: 'already_lifetime', message: 'Ya tenés el acceso de por vida. No hay nada más que pagar.' };
    }
    return null;                               // mejora: se permite
  }

  /* Mensual o pase semanal teniendo Pro = cobrarle dos veces lo mismo. */
  if (PROVIDERS_DE_POR_VIDA.has(proveedor)) {
    return { code: 'already_lifetime', message: 'Ya tenés el acceso de por vida. No hace falta que pagues nada más.' };
  }
  if (proveedor === 'org_license') {
    return { code: 'already_pro', message: 'Tu acceso Pro ya está cubierto por tu institución.' };
  }
  return { code: 'already_pro', message: 'Ya tenés Mavante Pro activo. Si querés cambiar de plan, escribinos a support@mavante.com.' };
};

/**
 * Al comprar el de por vida, ¿hay que darle de baja una suscripción que se
 * sigue cobrando? Si no lo hiciéramos, la persona pagaría el plan definitivo y
 * le seguiría entrando el débito mensual: cobrado dos veces por lo mismo, que es
 * exactamente lo que esta función existe para evitar.
 *
 * @param {{provider?:string, status?:string, subscription_id?:string|null}|null} fila
 * @param {string} planComprado
 */
export const debeCancelarRecurrente = (fila, planComprado) =>
  planComprado === 'lifetime' && recurrenteViva(fila) && Boolean(fila.subscription_id);

/**
 * @param {{tier?:string, sub_provider?:string|null, sub_until?:Date|string|null}} u
 * @returns {'free'|'pro'} el plan que de verdad rige AHORA
 */
export const tierEfectivo = (u) => {
  const fila = u || {};
  if (fila.tier !== 'pro') return 'free';
  if (!PROVIDERS_CON_VENCIMIENTO.has(fila.sub_provider)) return 'pro';
  if (!fila.sub_until) return 'pro';          // sin fecha anotada, no inventamos un vencimiento
  const hasta = new Date(fila.sub_until).getTime();
  if (Number.isNaN(hasta)) return 'pro';      // fecha ilegible: ante la duda, NO le sacamos lo que pagó
  return hasta > Date.now() ? 'pro' : 'free';
};

const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * Hasta cuándo llega un pase con vencimiento que se acaba de comprar.
 *
 * SUMA sobre lo que quede: si alguien con 5 días de pase todavía vivos compra
 * otro, tiene que terminar con 12, no con 7. Contar siempre desde hoy le comería
 * días pagados a quien renueva antes de que se le vacíe — el error se paga con
 * la plata del usuario, así que se resuelve a su favor.
 *
 * @param {number|null} dias  días que otorga el plan (null = no vence)
 * @param {Date|string|null} vigenteHasta  vencimiento que YA tenía, si tenía
 * @param {number} [ahora]  epoch ms (inyectable para poder testearlo)
 * @returns {Date|null} null si el plan no vence
 */
export const nuevoVencimiento = (dias, vigenteHasta, ahora = Date.now()) => {
  if (!dias) return null;
  const previo = vigenteHasta ? new Date(vigenteHasta).getTime() : 0;
  const desde = Number.isFinite(previo) && previo > ahora ? previo : ahora;
  return new Date(desde + dias * DIA_MS);
};

/**
 * SELECT compartido: la cuenta + el acceso que la respalda. Se usa en el
 * middleware y en /auth/me para que los dos vean EXACTAMENTE el mismo plan (si
 * uno mirara solo users.tier, el front y el servidor discreparían).
 */
export const SELECT_USER_CON_ACCESO = `
  select u.id, u.email, u.name, u.tier, u.is_verified,
         u.is_visible_to_companies,
         s.provider          as sub_provider,
         s.current_period_end as sub_until
    from users u
    left join subscriptions s on s.user_id = u.id
   where u.id = $1`;
