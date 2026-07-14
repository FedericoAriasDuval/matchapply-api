/**
 * test/resilience.test.js
 * Lo que tiene que aguantar el viernes. Sin mocks de mentira: se ejecuta de verdad.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Queue, QueueFullError, TimeoutError } from '../src/lib/queue.js';
import { CircuitBreaker } from '../src/lib/breaker.js';

/* ---------------------------------------------------------------- COLA ---- */

test('la cola respeta la concurrencia: nunca corren mas de N a la vez', async () => {
  const q = new Queue({ concurrency: 3, maxQueue: 100, timeoutMs: 5000 });
  let running = 0, peak = 0;

  const job = () => new Promise((r) => {
    running++; peak = Math.max(peak, running);
    setTimeout(() => { running--; r('ok'); }, 20);
  });

  await Promise.all(Array.from({ length: 30 }, () => q.run(job)));
  assert.equal(peak, 3, `el pico de concurrencia fue ${peak}, deberia ser 3`);
  assert.equal(q.stats.done, 30);
});

test('la cola rechaza cuando se desborda, en vez de aceptar y morir', async () => {
  const q = new Queue({ concurrency: 1, maxQueue: 2, timeoutMs: 5000 });
  const lento = () => new Promise((r) => setTimeout(r, 50));

  const p1 = q.run(lento);           // corre
  const p2 = q.run(lento);           // fila 1
  const p3 = q.run(lento);           // fila 2
  await assert.rejects(() => q.run(lento), QueueFullError);   // desbordada: se dice AHORA

  await Promise.all([p1, p2, p3]);
  assert.equal(q.stats.rejected, 1);
});

test('el rechazo trae una espera estimada honesta (no un error pelado)', async () => {
  const q = new Queue({ concurrency: 1, maxQueue: 1, timeoutMs: 5000 });
  const lento = () => new Promise((r) => setTimeout(r, 40));
  const a = q.run(lento); const b = q.run(lento);
  try {
    await q.run(lento);
    assert.fail('deberia haber rechazado');
  } catch (e) {
    assert.ok(e instanceof QueueFullError);
    assert.ok(typeof e.etaSeconds === 'number' && e.etaSeconds >= 0, 'tiene que decir cuanto esperar');
  }
  await Promise.all([a, b]);
});

test('un trabajo colgado NO congela la fila: el timeout libera el slot', async () => {
  const q = new Queue({ concurrency: 1, maxQueue: 10, timeoutMs: 60 });
  const colgado = () => new Promise(() => {});          // nunca resuelve: el peor caso
  const rapido = () => Promise.resolve('vivo');

  const colgadoP = assert.rejects(() => q.run(colgado), TimeoutError);
  const rapidoP = q.run(rapido);                        // este NO puede quedar rehen

  await colgadoP;
  assert.equal(await rapidoP, 'vivo');
  assert.equal(q.stats.timedOut, 1);
});

/* ------------------------------------------------------------- BREAKER ---- */

test('el breaker abre tras N fallos y deja de castigar al usuario con esperas', async () => {
  const b = new CircuitBreaker({ threshold: 3, cooldownMs: 1000 });
  const cae = () => Promise.reject(new Error('proveedor caido'));

  for (let i = 0; i < 3; i++) await assert.rejects(() => b.run(cae));
  assert.equal(b.state, 'open');

  const t0 = Date.now();
  await assert.rejects(() => b.run(cae));               // ya no llama: falla al instante
  assert.ok(Date.now() - t0 < 20, 'con el circuito abierto tiene que fallar en milisegundos');
  assert.equal(b.stats.shortCircuited, 1);
});

test('con el circuito abierto, el fallback salva al usuario', async () => {
  const b = new CircuitBreaker({ threshold: 1, cooldownMs: 1000 });
  await b.run(() => Promise.reject(new Error('x')), () => 'motor local');
  assert.equal(b.state, 'open');
  const out = await b.run(() => Promise.reject(new Error('x')), () => 'motor local');
  assert.equal(out, 'motor local', 'el usuario recibe un resultado, no un error');
});

test('el breaker se cierra solo cuando el proveedor vuelve', async () => {
  const b = new CircuitBreaker({ threshold: 1, cooldownMs: 30 });
  await assert.rejects(() => b.run(() => Promise.reject(new Error('x'))));
  assert.equal(b.state, 'open');
  await new Promise((r) => setTimeout(r, 45));          // pasa el enfriamiento
  const out = await b.run(() => Promise.resolve('ok')); // llamada de prueba
  assert.equal(out, 'ok');
  assert.equal(b.state, 'closed', 'tiene que cerrarse solo');
});
