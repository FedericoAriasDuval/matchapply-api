/**
 * src/lib/orgLicense.js
 *
 * Licencias institucionales: una universidad o un municipio paga por N personas
 * y cada persona canjea un código para tener Pro hasta la fecha del contrato.
 *
 * Acá vive SOLO la decisión —¿este código sirve para esta persona, hoy?— sin
 * tocar la base. Está separado para poder probarlo de verdad: las reglas que
 * deciden quién entra y quién no son las que hay que poder ejercitar cien veces
 * en un test, no las consultas SQL.
 *
 * El acceso que otorga se anota en subscriptions con provider = 'org_license' y
 * current_period_end = valid_until, o sea el MISMO mecanismo del pase semanal
 * (lib/tier.js). Una sola forma de vencer en todo el sistema; no dos.
 */

/** El código se dicta por teléfono y se copia de un PDF: se compara normalizado. */
export const normalizarCodigo = (valor) =>
  String(valor ?? '').trim().toUpperCase().replace(/\s+/g, '');

/** El dominio de un email, sin arroba y en minúscula. '' si el email es basura. */
export const dominioDeEmail = (email) => {
  const partes = String(email ?? '').trim().toLowerCase().split('@');
  return partes.length === 2 ? partes[1] : '';
};

/**
 * ¿El email pertenece al dominio autorizado?
 * Sin dominio configurado, cualquiera puede canjear (y el único freno es el cupo).
 * Los subdominios entran: alguien de alumnos.udesa.edu.ar es de udesa.edu.ar, y
 * dejarlo afuera obligaría a la institución a cargar una licencia por facultad.
 */
export const dominioAutorizado = (email, dominioLicencia) => {
  const permitido = String(dominioLicencia ?? '').trim().toLowerCase().replace(/^@/, '');
  if (!permitido) return true;
  const suyo = dominioDeEmail(email);
  return suyo === permitido || suyo.endsWith('.' + permitido);
};

/**
 * ¿Se puede canjear? Devuelve null si sí, o { code, message } si no.
 *
 * Cada negativa dice QUÉ pasó y qué hacer, porque del otro lado hay alguien que
 * copió un código de un mail y no tiene a quién preguntarle. "No se pudo" a
 * secas manda a esa persona a esperar en vez de a destrabarse.
 *
 * @param {object|null} lic      fila de org_licenses (null = el código no existe)
 * @param {object} ctx           { usados, email, yaEsMiembro, ahora }
 */
export const motivoDeRechazo = (lic, { usados = 0, email = '', yaEsMiembro = false, ahora = Date.now() } = {}) => {
  if (!lic || !lic.is_active) {
    return { code: 'license_unknown', message: 'Ese código no existe o ya no está activo. Revisá que esté completo.' };
  }
  const vence = new Date(lic.valid_until).getTime();
  if (Number.isNaN(vence) || vence <= ahora) {
    return { code: 'license_expired', message: 'Ese código venció. Pedile uno nuevo a quien te lo dio.' };
  }
  if (!dominioAutorizado(email, lic.email_domain)) {
    return {
      code: 'license_domain',
      message: `Ese código es solo para cuentas @${String(lic.email_domain).toLowerCase()}. Entrá con ese email y volvé a probar.`,
    };
  }
  /* El cupo se revisa DESPUÉS del dominio a propósito: si el código no era para
     vos, saber cuánta gente lo usó no te sirve de nada. */
  if (!yaEsMiembro && usados >= lic.max_users) {
    return { code: 'license_full', message: 'Ese código ya llegó a su cupo de personas. Avisale a quien te lo dio.' };
  }
  return null;
};
