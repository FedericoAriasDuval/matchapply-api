import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clasificarMpHook, parseRefMp } from '../src/lib/mpHook.js';

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

/* El pago único codifica el plan en external_reference ("userId|plan") porque MP no
   propaga el metadata de la preference al payment. La suscripción manda solo el userId. */
test('parseRefMp: pago único trae userId y plan del external_reference', () => {
  assert.deepEqual(parseRefMp('u-123|week', ''), { userId: 'u-123', plan: 'week' });
  assert.deepEqual(parseRefMp('u-123|lifetime', undefined), { userId: 'u-123', plan: 'lifetime' });
});

test('parseRefMp: suscripción (sin "|") -> userId y plan vacío', () => {
  assert.deepEqual(parseRefMp('u-999', ''), { userId: 'u-999', plan: '' });
});

test('parseRefMp: si no viene en el ref, cae al metadata', () => {
  assert.deepEqual(parseRefMp('u-1', 'WEEK'), { userId: 'u-1', plan: 'week' });   // metadata como respaldo, en minúscula
});

test('parseRefMp: vacío/nulo no rompe', () => {
  assert.deepEqual(parseRefMp('', ''), { userId: null, plan: '' });
  assert.deepEqual(parseRefMp(null, null), { userId: null, plan: '' });
  assert.deepEqual(parseRefMp(undefined, undefined), { userId: null, plan: '' });
});
