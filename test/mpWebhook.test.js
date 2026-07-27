import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clasificarMpHook } from '../src/lib/mpHook.js';

/* El bug que rompía la activación de Pro: "subscription_authorized_payment"
   contiene "subscription" Y "payment". Con el regex viejo caía en el branch de
   preapproval y hacía fetch de un preapproval con un id de PAGO → 404 → nunca
   acreditaba ni activaba nada. Tiene que clasificar como authpay. */
test('clasificarMpHook: subscription_authorized_payment -> authpay (NO preapproval)', () => {
  assert.equal(clasificarMpHook('subscription_authorized_payment'), 'authpay');
});

test('clasificarMpHook: la autorización de la suscripción -> preapproval', () => {
  assert.equal(clasificarMpHook('subscription_preapproval'), 'preapproval');
  assert.equal(clasificarMpHook('preapproval'), 'preapproval');
});

test('clasificarMpHook: pago suelto -> payment (topic viejo también)', () => {
  assert.equal(clasificarMpHook('payment'), 'payment');
  assert.equal(clasificarMpHook('PAYMENT'), 'payment');   // el topic del IPN viejo llega en mayúsculas
});

test('clasificarMpHook: lo desconocido no rompe', () => {
  assert.equal(clasificarMpHook('merchant_order'), 'unknown');
  assert.equal(clasificarMpHook(''), 'unknown');
  assert.equal(clasificarMpHook(undefined), 'unknown');
  assert.equal(clasificarMpHook(null), 'unknown');
});
