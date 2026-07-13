import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPasswordStrength } from '../src/lib/passwordPolicy.js';

test('rechaza contraseñas que no cumplen las 5 reglas', () => {
  for (const weak of ['hola', 'holamundo', 'Holamundo', 'Holamundo1', 'Corta1!', 'SINMINUSCULA1!']) {
    assert.equal(checkPasswordStrength(weak).ok, false, `debería rechazar: ${weak}`);
  }
});

test('acepta una contraseña que cumple las 5 reglas', () => {
  const r = checkPasswordStrength('Segura2026!');
  assert.equal(r.ok, true);
  assert.equal(r.score, 5);
  assert.deepEqual(r.failed, []);
});

test('rechaza contraseñas comunes aunque cumplan el patrón', () => {
  assert.equal(checkPasswordStrength('Password1!').ok, false);
});

test('informa exactamente qué regla falló', () => {
  const r = checkPasswordStrength('holamundo1');
  assert.ok(r.failed.includes('Al menos una mayúscula'));
  assert.ok(r.failed.includes('Al menos un carácter especial'));
});
