import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROVIDERS_CON_VENCIMIENTO, nuevoVencimiento, tierEfectivo } from '../src/lib/tier.js';

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

test('la licencia institucional también caduca (usa el mismo camino)', () => {
  assert.ok(PROVIDERS_CON_VENCIMIENTO.has('org_license'));
  assert.equal(tierEfectivo({ tier: 'pro', sub_provider: 'org_license', sub_until: enDias(30) }), 'pro');
  assert.equal(tierEfectivo({ tier: 'pro', sub_provider: 'org_license', sub_until: enDias(-1) }), 'free');
});
