/**
 * test/consent.test.js
 *
 * El consentimiento OPT-IN para el Panel de Talento.
 *
 * El bug que esto fija: el front mandaba `isDiscoverable` y el back leía
 * `isVisibleToCompanies` (quedaron desalineados tras el rename de la migración
 * 005), así que el checkbox que la persona tildaba se perdía en silencio y nadie
 * quedaba visible aunque hubiera dado el consentimiento.
 *
 * Regla que estos tests hacen cumplir: el consentimiento es OPT-IN (por defecto
 * NO), y se lee del alta sin importar cuál de los dos nombres mande el front.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wantsCompanyVisibility } from '../src/lib/consent-rules.js';

test('por defecto NO comparte (opt-in): sin el campo, es false', () => {
  assert.equal(wantsCompanyVisibility({}), false);
  assert.equal(wantsCompanyVisibility({ name: 'Ana', email: 'a@b.com' }), false);
});

test('lee el nombre nuevo (isVisibleToCompanies)', () => {
  assert.equal(wantsCompanyVisibility({ isVisibleToCompanies: true }), true);
  assert.equal(wantsCompanyVisibility({ isVisibleToCompanies: false }), false);
});

test('lee el nombre viejo como alias (isDiscoverable) — el que perdía el consentimiento', () => {
  assert.equal(wantsCompanyVisibility({ isDiscoverable: true }), true);
  assert.equal(wantsCompanyVisibility({ isDiscoverable: false }), false);
});

test('el nombre nuevo tiene prioridad si vienen los dos', () => {
  assert.equal(wantsCompanyVisibility({ isVisibleToCompanies: true, isDiscoverable: false }), true);
  assert.equal(wantsCompanyVisibility({ isVisibleToCompanies: false, isDiscoverable: true }), false);
});

test('nunca devuelve algo que no sea booleano, ni explota con basura', () => {
  assert.strictEqual(wantsCompanyVisibility(null), false);
  assert.strictEqual(wantsCompanyVisibility(undefined), false);
  assert.strictEqual(wantsCompanyVisibility({ isVisibleToCompanies: 1 }), true);   // truthy → true, no 1
  assert.strictEqual(wantsCompanyVisibility({ isVisibleToCompanies: 0 }), false);
});
