import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LruCache } from '../src/lib/cache.js';

test('devuelve el valor cacheado sin volver a ejecutar la función', async () => {
  const cache = new LruCache({ max: 10 });
  let calls = 0;
  const fn = async () => { calls++; return 'resultado'; };
  assert.equal(await cache.wrap('k', fn), 'resultado');
  assert.equal(await cache.wrap('k', fn), 'resultado');
  assert.equal(calls, 1, 'la llamada al modelo se hizo una sola vez');
  assert.equal(cache.stats.hits, 1);
});

test('deduplica llamadas concurrentes al mismo CV', async () => {
  const cache = new LruCache();
  let calls = 0;
  const slow = async () => { calls++; await new Promise((r) => setTimeout(r, 30)); return calls; };
  const out = await Promise.all([cache.wrap('x', slow), cache.wrap('x', slow), cache.wrap('x', slow)]);
  assert.equal(calls, 1, 'tres pedidos simultáneos = una sola llamada');
  assert.deepEqual(out, [1, 1, 1]);
});

test('expulsa el menos usado recientemente al llenarse', () => {
  const cache = new LruCache({ max: 2 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a');
  cache.set('c', 3);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('c'), 3);
});

test('respeta el TTL', async () => {
  const cache = new LruCache({ ttlMs: 20 });
  cache.set('k', 'v');
  assert.equal(cache.get('k'), 'v');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(cache.get('k'), undefined);
});
