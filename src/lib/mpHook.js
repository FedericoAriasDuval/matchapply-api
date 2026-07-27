/**
 * Clasificación de los avisos (webhooks) de Mercado Pago. Módulo PURO —sin config,
 * sin red, sin base—: se puede testear en aislamiento (por eso vive acá y no en la
 * ruta, que arrastra credenciales y clientes).
 *
 * El ORDEN importa: "subscription_authorized_payment" contiene "subscription" Y
 * "payment". Se chequea PRIMERO como authpay; si no, preapproval; recién después el
 * pago suelto. Con el regex viejo caía en preapproval y hacía fetch de un
 * preapproval con un id de PAGO → 404 → nunca acreditaba ni activaba el Pro.
 */
export const clasificarMpHook = (type) => {
  const t = String(type ?? '').toLowerCase();
  if (/authorized_payment/.test(t)) return 'authpay';
  if (/preapproval|subscription/.test(t)) return 'preapproval';
  if (/payment/.test(t)) return 'payment';
  return 'unknown';
};

/**
 * Desarma el external_reference de un pago de MP. El pago ÚNICO manda "userId|plan"
 * (porque MP NO copia el metadata de la preference al payment, pero SÍ propaga el
 * external_reference); la suscripción manda solo "userId" (sin "|"). metadata queda
 * como respaldo del plan. Devuelve { userId, plan } — plan en minúscula, "" si no hay.
 */
export const parseRefMp = (externalReference, metadataPlan) => {
  const [uid, planRef] = String(externalReference ?? '').split('|');
  return { userId: uid || null, plan: String(planRef || metadataPlan || '').toLowerCase() };
};
