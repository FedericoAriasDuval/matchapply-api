import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PROVIDERS_CON_VENCIMIENTO, bloqueoDeCompra, debeCancelarRecurrente,
  nuevoVencimiento, recurrenteViva, tierEfectivo,
} from '../src/lib/tier.js';

const DIA = 24 * 60 * 60 * 1000;
const enDias = (n) => new Date(Date.now() + n * DIA);

test('pase semanal: da Pro mientras esté vigente', () => {
  assert.equal(
    tierEfectivo({ tier: 'pro', sub_provider: 'mercadopago_week', sub_until: enDias(7) }),
    'pro',
  );
  // recién comprado y a punto de vencer, sigue siendo Pro
  assert.equal(
    tierEfectivo({ tier: 'pro', sub_provider: 'mercadopago_week', sub_until: new Date(Date.now() + 60_000) }),
    'pro',
  );
});

test('pase semanal: a los 7 días CADUCA y vuelve a free', () => {
  // el pase se compró hace 7 días y un minuto: ya venció
  assert.equal(
    tierEfectivo({ tier: 'pro', sub_provider: 'mercadopago_week', sub_until: new Date(Date.now() - 60_000) }),
    'free',
  );
  assert.equal(
    tierEfectivo({ tier: 'pro', sub_provider: 'paddle_week', sub_until: enDias(-1) }),
    'free',
  );
});

test('el plan de por vida NO vence nunca', () => {
  assert.equal(tierEfectivo({ tier: 'pro', sub_provider: 'mercadopago_lifetime', sub_until: null }), 'pro');
  // aunque quedara una fecha vieja colgada, no se le saca lo que pagó
  assert.equal(tierEfectivo({ tier: 'pro', sub_provider: 'paddle_lifetime', sub_until: enDias(-400) }), 'pro');
});

test('la suscripción MENSUAL no se baja por fecha local (la maneja el webhook)', () => {
  /* Si la bajáramos acá, un aviso demorado de Mercado Pago le cortaría el Pro a
     alguien que pagó. Es la misma razón por la que past_due no baja el plan. */
  assert.equal(tierEfectivo({ tier: 'pro', sub_provider: 'mercadopago', sub_until: enDias(-3) }), 'pro');
  assert.equal(tierEfectivo({ tier: 'pro', sub_provider: 'paddle', sub_until: enDias(-3) }), 'pro');
});

test('sin fecha o con fecha ilegible, ante la duda NO se saca el Pro', () => {
  assert.equal(tierEfectivo({ tier: 'pro', sub_provider: 'mercadopago_week', sub_until: null }), 'pro');
  assert.equal(tierEfectivo({ tier: 'pro', sub_provider: 'mercadopago_week', sub_until: 'no-es-fecha' }), 'pro');
});

test('quien no es pro sigue sin serlo (y nunca devuelve undefined)', () => {
  assert.equal(tierEfectivo({ tier: 'free' }), 'free');
  assert.equal(tierEfectivo({}), 'free');
  assert.equal(tierEfectivo({ tier: 'free', sub_provider: 'mercadopago_week', sub_until: enDias(7) }), 'free');
});

test('un pase nuevo, sin nada previo, vale exactamente 7 días', () => {
  const ahora = Date.UTC(2026, 6, 22, 12, 0, 0);
  assert.equal(nuevoVencimiento(7, null, ahora).getTime(), ahora + 7 * DIA);
  assert.equal(nuevoVencimiento(7, new Date(ahora - 30 * DIA), ahora).getTime(), ahora + 7 * DIA);
});

test('renovar antes de que se venza SUMA: no se le comen los días pagados', () => {
  const ahora = Date.UTC(2026, 6, 22, 12, 0, 0);
  const leQuedan5 = new Date(ahora + 5 * DIA);
  assert.equal(nuevoVencimiento(7, leQuedan5, ahora).getTime(), ahora + 12 * DIA);
});

test('el plan sin días no genera vencimiento', () => {
  assert.equal(nuevoVencimiento(null, new Date()), null);
  assert.equal(nuevoVencimiento(0, new Date()), null);
});

/* ── Nadie paga dos veces lo mismo ──────────────────────────────────────── */

const proMensual = { tier: 'pro', sub_provider: 'mercadopago', sub_until: null, status: 'authorized' };

test('un Pro con la mensual activa NO puede volver a comprar la mensual', () => {
  const b = bloqueoDeCompra(proMensual, 'monthly');
  assert.equal(b.code, 'already_pro');
  // y tampoco por el camino "sin plan", que es como llega el botón de la mensual
  assert.equal(bloqueoDeCompra(proMensual, '').code, 'already_pro');
  assert.equal(bloqueoDeCompra(proMensual, undefined).code, 'already_pro');
});

test('un Pro tampoco puede comprarse el pase semanal (sería el mismo acceso dos veces)', () => {
  assert.equal(bloqueoDeCompra(proMensual, 'week').code, 'already_pro');
});

test('un Pro con la mensual SÍ puede pasarse al de por vida', () => {
  assert.equal(bloqueoDeCompra(proMensual, 'lifetime'), null);
});

test('quien ya tiene el de por vida no puede comprar NADA más', () => {
  const life = { tier: 'pro', sub_provider: 'paddle_lifetime', sub_until: null };
  assert.equal(bloqueoDeCompra(life, 'lifetime').code, 'already_lifetime');
  assert.equal(bloqueoDeCompra(life, 'monthly').code, 'already_lifetime');
  assert.equal(bloqueoDeCompra(life, 'week').code, 'already_lifetime');
});

test('el Pro que viene de una licencia institucional tampoco compra de nuevo', () => {
  const org = { tier: 'pro', sub_provider: 'org_license', sub_until: enDias(200) };
  assert.equal(bloqueoDeCompra(org, 'monthly').code, 'already_pro');
  assert.equal(bloqueoDeCompra(org, 'lifetime'), null);   // pagarse el suyo propio sí puede
});

test('con el pase semanal VENCIDO se puede comprar de todo otra vez', () => {
  const vencido = { tier: 'pro', sub_provider: 'mercadopago_week', sub_until: enDias(-1) };
  assert.equal(bloqueoDeCompra(vencido, 'monthly'), null);
  assert.equal(bloqueoDeCompra(vencido, 'week'), null);
});

test('quien no es Pro puede comprar cualquier plan', () => {
  for (const plan of ['monthly', 'week', 'lifetime', '']) {
    assert.equal(bloqueoDeCompra({ tier: 'free' }, plan), null);
    assert.equal(bloqueoDeCompra(null, plan), null);
  }
});

/* ── Comprar el de por vida da de baja el débito mensual ─────────────────── */

test('comprar el de por vida cancela la suscripción recurrente que estaba viva', () => {
  const fila = { provider: 'mercadopago', status: 'authorized', subscription_id: 'preapproval-123' };
  assert.equal(debeCancelarRecurrente(fila, 'lifetime'), true);
  assert.equal(debeCancelarRecurrente({ provider: 'paddle', status: 'active', subscription_id: 'sub_1' }, 'lifetime'), true);
  // past_due sigue siendo una suscripción que se cobra: también se cancela
  assert.equal(debeCancelarRecurrente({ provider: 'paddle', status: 'past_due', subscription_id: 'sub_1' }, 'lifetime'), true);
});

test('el pase semanal NO cancela nada (no es una mejora de plan)', () => {
  const fila = { provider: 'mercadopago', status: 'authorized', subscription_id: 'preapproval-123' };
  assert.equal(debeCancelarRecurrente(fila, 'week'), false);
});

test('no se intenta cancelar lo que no existe o ya está cancelado', () => {
  assert.equal(debeCancelarRecurrente(null, 'lifetime'), false);
  assert.equal(debeCancelarRecurrente({ provider: 'mercadopago', status: 'cancelled', subscription_id: 'x' }, 'lifetime'), false);
  assert.equal(debeCancelarRecurrente({ provider: 'mercadopago', status: 'authorized', subscription_id: null }, 'lifetime'), false);
  // un pago único anterior no es una suscripción: no hay nada que dar de baja
  assert.equal(debeCancelarRecurrente({ provider: 'mercadopago_week', status: 'active', subscription_id: 'pay-9' }, 'lifetime'), false);
});

test('recurrenteViva distingue la que se cobra de la que ya murió', () => {
  assert.ok(recurrenteViva({ provider: 'paddle', status: 'active' }));
  assert.ok(recurrenteViva({ provider: 'mercadopago', status: 'authorized' }));
  assert.ok(!recurrenteViva({ provider: 'paddle', status: 'canceled' }));
  assert.ok(!recurrenteViva({ provider: 'org_license', status: 'active' }));
  assert.ok(!recurrenteViva(null));
});

test('la licencia institucional también caduca (usa el mismo camino)', () => {
  assert.ok(PROVIDERS_CON_VENCIMIENTO.has('org_license'));
  assert.equal(tierEfectivo({ tier: 'pro', sub_provider: 'org_license', sub_until: enDias(30) }), 'pro');
  assert.equal(tierEfectivo({ tier: 'pro', sub_provider: 'org_license', sub_until: enDias(-1) }), 'free');
});
