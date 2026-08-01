/**
 * test/extensionToken.test.js
 *
 * Lo testeable sin base de la lib de tokens de la extensión: reconocer el
 * formato (para que el middleware distinga un token de extensión de un JWT sin
 * pegarle a la base) y el cálculo del vencimiento. La parte con DB (emitir,
 * validar, revocar) se prueba en el deploy/manual, como el resto de las rutas.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  esTokenExtension,
  vencimientoExtension,
  nuevoTokenExtensionRaw,
  EXT_PREFIX,
  EXT_TTL_DAYS,
} from '../src/lib/extensionTokens.js';

test('esTokenExtension: acepta el formato mavx_ con cuerpo largo', () => {
  assert.equal(esTokenExtension(nuevoTokenExtensionRaw()), true);
  assert.equal(esTokenExtension(EXT_PREFIX + 'a'.repeat(30)), true);
});

test('esTokenExtension: rechaza lo que no es un token de extensión', () => {
  assert.equal(esTokenExtension(''), false);
  assert.equal(esTokenExtension(null), false);
  assert.equal(esTokenExtension(undefined), false);
  assert.equal(esTokenExtension(12345), false);
  assert.equal(esTokenExtension('mavx_corto'), false);                 // cuerpo muy corto
  assert.equal(esTokenExtension('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.x.y'), false); // un JWT
  assert.equal(esTokenExtension('Bearer mavx_' + 'a'.repeat(30)), false);            // con el prefijo pegado
});

test('nuevoTokenExtensionRaw: empieza con el prefijo y se reconoce a sí mismo', () => {
  const raw = nuevoTokenExtensionRaw();
  assert.ok(raw.startsWith(EXT_PREFIX));
  assert.ok(raw.length > EXT_PREFIX.length + 30, 'el cuerpo aleatorio tiene que ser largo');
  assert.equal(esTokenExtension(raw), true);
  // dos seguidos no pueden ser iguales (aleatoriedad real)
  assert.notEqual(raw, nuevoTokenExtensionRaw());
});

test('vencimientoExtension: cae ttlDays en el futuro respecto del ahora inyectado', () => {
  const ahora = 1_700_000_000_000; // epoch fijo, sin Date.now real
  const v = vencimientoExtension(EXT_TTL_DAYS, ahora);
  assert.equal(v.getTime(), ahora + EXT_TTL_DAYS * 86_400_000);
  // TTL custom
  assert.equal(vencimientoExtension(7, ahora).getTime(), ahora + 7 * 86_400_000);
});

test('EXT_TTL_DAYS es un plazo largo y razonable (semanas, no minutos)', () => {
  assert.ok(EXT_TTL_DAYS >= 30 && EXT_TTL_DAYS <= 365);
});
