import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAllowedOrigin } from '../src/lib/cors.js';

const APP = 'https://mavante.com';
const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';   // id de 32 chars

test('CORS: sin Origin (curl, health, same-origin) → permitido', () => {
  assert.equal(isAllowedOrigin(undefined, APP), true);
  assert.equal(isAllowedOrigin('', APP), true);
});

test('CORS: el sitio (appUrl) → permitido; otra web → bloqueada', () => {
  assert.equal(isAllowedOrigin(APP, APP), true);
  assert.equal(isAllowedOrigin('https://evil.com', APP), false);
  assert.equal(isAllowedOrigin('https://mavante.com.evil.com', APP), false);
});

test('CORS: la variante www del mismo sitio → permitida (Cloudflare sirve apex y www)', () => {
  assert.equal(isAllowedOrigin('https://www.mavante.com', APP), true);
  // pero NO variantes que solo se le parecen
  assert.equal(isAllowedOrigin('https://www.mavante.com.evil.com', APP), false);
  assert.equal(isAllowedOrigin('https://wwwmavante.com', APP), false);
  // y no rompe si appUrl ya trae www (no genera www.www)
  assert.equal(isAllowedOrigin('https://www.mavante.com', 'https://www.mavante.com'), true);
});

test('CORS: cualquier extensión de Chrome cuando NO hay EXTENSION_ORIGIN (dev)', () => {
  assert.equal(isAllowedOrigin(EXT, APP, ''), true);
});

test('CORS: con EXTENSION_ORIGIN seteado, SOLO esa extensión', () => {
  const otra = 'chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
  assert.equal(isAllowedOrigin(EXT, APP, EXT), true);
  assert.equal(isAllowedOrigin(otra, APP, EXT), false);
});

test('CORS: un chrome-extension:// mal formado no pasa', () => {
  assert.equal(isAllowedOrigin('chrome-extension://short', APP, ''), false);
  assert.equal(isAllowedOrigin('chrome-extension://', APP, ''), false);
});
