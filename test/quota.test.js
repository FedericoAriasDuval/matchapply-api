import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quotaSpec, periodKey, isUncounted } from '../src/lib/quota.js';

/* Espejo de config.limits / config.quotaWindow (rediseño de cuotas 31/07):
   Free 2 diag / 1 adapt DE POR VIDA · Plus 6 / 15 por MES · Pro ilimitado. */
const LIMITS = {
  free: { diagnostic: 2, tailor: 1 },
  plus: { diagnostic: 6, tailor: 15 },
  pro:  { diagnostic: Infinity, tailor: Infinity },
};
const WINDOWS = { free: 'life', plus: 'month', pro: 'none' };

test('quotaSpec: free cuenta 2 diagnósticos y 1 adaptación, de por vida', () => {
  assert.deepEqual(quotaSpec('free', 'diagnostic', LIMITS, WINDOWS), { max: 2, window: 'life' });
  assert.deepEqual(quotaSpec('free', 'tailor', LIMITS, WINDOWS), { max: 1, window: 'life' });
});

test('quotaSpec: plus cuenta 6 y 15, por mes', () => {
  assert.deepEqual(quotaSpec('plus', 'diagnostic', LIMITS, WINDOWS), { max: 6, window: 'month' });
  assert.deepEqual(quotaSpec('plus', 'tailor', LIMITS, WINDOWS), { max: 15, window: 'month' });
});

test('quotaSpec: pro es ilimitado y no se cuenta', () => {
  const s = quotaSpec('pro', 'diagnostic', LIMITS, WINDOWS);
  assert.equal(s.max, Infinity);
  assert.equal(s.window, 'none');
  assert.equal(isUncounted(s), true);
});

test('quotaSpec: un tier desconocido cae a FREE, nunca a ilimitado', () => {
  assert.deepEqual(quotaSpec('gold', 'diagnostic', LIMITS, WINDOWS), { max: 2, window: 'life' });
});

test('quotaSpec: una acción sin entrada (carta/entrevista) es ilimitada', () => {
  const s = quotaSpec('free', 'cover', LIMITS, WINDOWS);   // 'cover' no está en limits → sin tope
  assert.equal(s.max, Infinity);
  assert.equal(isUncounted(s), true);
});

test('isUncounted: free con tope finito SÍ se cuenta', () => {
  assert.equal(isUncounted(quotaSpec('free', 'diagnostic', LIMITS, WINDOWS)), false);
  assert.equal(isUncounted(quotaSpec('plus', 'tailor', LIMITS, WINDOWS)), false);
});

test('periodKey: la ventana de por vida es una sola clave fija → el Free NUNCA resetea', () => {
  assert.equal(periodKey('life', new Date('2026-01-15')), 'life');
  assert.equal(periodKey('life', new Date('2027-08-30')), 'life');   // año siguiente, misma clave
  assert.equal(periodKey('none', new Date('2026-05-01')), 'life');   // pro tampoco cuenta
});

test('periodKey: la ventana mensual cambia de clave al cambiar de mes → resetea el 1°', () => {
  assert.equal(periodKey('month', new Date('2026-07-31T23:59:00Z')), '2026-07');
  assert.equal(periodKey('month', new Date('2026-08-01T00:01:00Z')), '2026-08');   // mes nuevo → contador desde cero
  assert.notEqual(
    periodKey('month', new Date('2026-07-15')),
    periodKey('month', new Date('2026-08-15')),
  );
});
