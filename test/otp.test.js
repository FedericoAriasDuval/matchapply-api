import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codeMatches, generateCode, hashCode } from '../src/lib/otpCore.js';

process.env.JWT_SECRET ??= 'test-pepper';

test('el código tiene siempre 6 dígitos', () => {
  for (let i = 0; i < 1000; i++) assert.match(generateCode(), /^\d{6}$/);
});

test('la distribución no está sesgada (rejection sampling)', () => {
  const buckets = new Array(10).fill(0);
  for (let i = 0; i < 6000; i++) buckets[Number(generateCode()[0])]++;
  const min = Math.min(...buckets);
  const max = Math.max(...buckets);
  assert.ok(max / min < 1.6, `distribución sospechosa: ${buckets.join(',')}`);
});

test('se persiste el hash, no el código; la comparación es correcta', () => {
  const code = generateCode();
  const h = hashCode(code);
  assert.notEqual(h, code);
  assert.equal(hashCode(code), h);
  assert.equal(codeMatches(code, h), true);
  assert.equal(codeMatches(code === '000000' ? '111111' : '000000', h), false);
});
