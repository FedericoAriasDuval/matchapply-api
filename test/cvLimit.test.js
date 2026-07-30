import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cvLimitReached } from '../src/lib/cvLimit.js';

/* El tope de CVs GUARDADOS es distinto de la cuota diaria de IA. Free: 2 CVs
   (ej: uno por rubro o idioma). Pro: sin tope. El fundador nunca se topa. */
const LIMITS = { free: 2, pro: Infinity };

test('cvLimitReached: free se topa recién al tener 2 (el 3ro se bloquea)', () => {
  const free = { isFounder: false, tier: 'free', limits: LIMITS };
  assert.equal(cvLimitReached({ ...free, count: 0 }), false);
  assert.equal(cvLimitReached({ ...free, count: 1 }), false);   // puede crear el 2do
  assert.equal(cvLimitReached({ ...free, count: 2 }), true);     // ya tiene 2 → el 3ro NO
  assert.equal(cvLimitReached({ ...free, count: 7 }), true);
});

test('cvLimitReached: Pro nunca se topa', () => {
  const pro = { isFounder: false, tier: 'pro', limits: LIMITS };
  assert.equal(cvLimitReached({ ...pro, count: 2 }), false);
  assert.equal(cvLimitReached({ ...pro, count: 999 }), false);
});

test('cvLimitReached: el fundador nunca se topa aunque sea free', () => {
  assert.equal(cvLimitReached({ isFounder: true, tier: 'free', count: 99, limits: LIMITS }), false);
});
