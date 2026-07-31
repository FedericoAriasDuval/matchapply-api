import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  claveSub, esPeriodo, esTierPago, frecuenciaMp, mpMontoSub,
  paddlePriceSub, tierDePaddlePrice, tierDeRefMp, tierPagoRecurrente,
} from '../src/lib/planCatalog.js';

const PADDLE = {
  plus_monthly: 'pri_plusM', plus_annual: 'pri_plusA',
  pro_monthly: 'pri_proM', pro_annual: 'pri_proA',
};
const MP = { plus_monthly: 7990, plus_annual: 79000, pro_monthly: 20000, pro_annual: 180000 };

test('esTierPago: sólo plus y pro se pagan', () => {
  assert.equal(esTierPago('plus'), true);
  assert.equal(esTierPago('pro'), true);
  assert.equal(esTierPago('free'), false);
  assert.equal(esTierPago(''), false);
  assert.equal(esTierPago('lifetime'), false);
});

test('esPeriodo / claveSub: normaliza el período (cualquier cosa rara → mensual)', () => {
  assert.equal(esPeriodo('monthly'), true);
  assert.equal(esPeriodo('annual'), true);
  assert.equal(esPeriodo('semanal'), false);
  assert.equal(claveSub('plus', 'annual'), 'plus_annual');
  assert.equal(claveSub('pro', 'monthly'), 'pro_monthly');
  assert.equal(claveSub('pro', 'trimestral'), 'pro_monthly');   // desconocido → mensual
});

test('paddlePriceSub: el price correcto, o "" si no está (para que billing rechace)', () => {
  assert.equal(paddlePriceSub(PADDLE, 'plus', 'monthly'), 'pri_plusM');
  assert.equal(paddlePriceSub(PADDLE, 'pro', 'annual'), 'pri_proA');
  assert.equal(paddlePriceSub({}, 'pro', 'annual'), '');
  assert.equal(paddlePriceSub(PADDLE, 'gold', 'monthly'), '');
});

test('tierDePaddlePrice: mapa inverso; null si el price no está en el catálogo', () => {
  assert.equal(tierDePaddlePrice(PADDLE, 'pri_plusM'), 'plus');
  assert.equal(tierDePaddlePrice(PADDLE, 'pri_proA'), 'pro');
  assert.equal(tierDePaddlePrice(PADDLE, 'pri_desconocido'), null);
  assert.equal(tierDePaddlePrice(PADDLE, ''), null);
  assert.equal(tierDePaddlePrice({}, 'pri_plusM'), null);
});

test('mpMontoSub: el monto correcto, 0 si no está', () => {
  assert.equal(mpMontoSub(MP, 'plus', 'monthly'), 7990);
  assert.equal(mpMontoSub(MP, 'pro', 'annual'), 180000);
  assert.equal(mpMontoSub({}, 'pro', 'monthly'), 0);
});

test('frecuenciaMp: mensual = 1 mes; anual = 12 meses (MP no tiene "años")', () => {
  assert.deepEqual(frecuenciaMp('monthly'), { frequency: 1, frequency_type: 'months' });
  assert.deepEqual(frecuenciaMp('annual'), { frequency: 12, frequency_type: 'months' });
});

test('tierDeRefMp: el tier del ref; sin tier (viejo) o basura → Pro (grandfathering)', () => {
  assert.equal(tierDeRefMp('plus'), 'plus');
  assert.equal(tierDeRefMp('pro'), 'pro');
  assert.equal(tierDeRefMp(''), 'pro');           // suscriptor viejo (ref = userId, sin |tier)
  assert.equal(tierDeRefMp('lifetime'), 'pro');   // no es un tier de suscripción
  assert.equal(tierDeRefMp(undefined), 'pro');
});

test('tierPagoRecurrente: el ref del pago manda; si no trae tier, cae al hint; si no, Pro', () => {
  // el pago SÍ trae el tier → se usa ese
  assert.equal(tierPagoRecurrente('plus', 'pro'), 'plus');
  assert.equal(tierPagoRecurrente('pro', 'plus'), 'pro');
  // el pago NO trae tier (caso real de MP en cuotas) → cae al hint del authorized_payment
  assert.equal(tierPagoRecurrente('', 'plus'), 'plus');   // <-- el bug: antes esto daba 'pro' y subía un Plus a Pro
  assert.equal(tierPagoRecurrente('', 'pro'), 'pro');
  // ni pago ni hint traen tier (suscriptor viejo) → Pro (grandfathering)
  assert.equal(tierPagoRecurrente('', ''), 'pro');
  assert.equal(tierPagoRecurrente(undefined, undefined), 'pro');
  // un hint basura no cuenta como tier
  assert.equal(tierPagoRecurrente('', 'lifetime'), 'pro');
});
