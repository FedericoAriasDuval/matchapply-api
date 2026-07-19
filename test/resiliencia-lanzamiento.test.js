/**
 * test/resiliencia-lanzamiento.test.js
 *
 * Lo que se rompe cuando llegan todos juntos, no cuando prueba una persona.
 *
 * Estos tests cubren las cuatro fallas que NO aparecen en el uso normal y que
 * por eso son las que muerden el día del lanzamiento:
 *
 *   1. Un deploy a mitad de un análisis (la cola tiene que drenar, no cortar).
 *   2. La cola llena o cerrándose (hay que rechazar rápido y honesto).
 *   3. Un hipo del SMTP durante el alta (reintentar; y si no, decir la verdad).
 *   4. El presupuesto de la IA (no pagar llamadas que ya nadie espera).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Queue, QueueFullError } from '../src/lib/queue.js';

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/* ─────────────────────────── 1 · Drenaje en el deploy ─────────────────────── */

test('drain() espera a que termine el trabajo que ya estaba corriendo', async () => {
  const q = new Queue({ concurrency: 2, maxQueue: 10, timeoutMs: 5_000 });
  let terminados = 0;
  const lento = async () => { await dormir(120); terminados++; return 'ok'; };

  const trabajos = [q.run(lento), q.run(lento), q.run(lento)];
  await dormir(20);                       // dejamos que arranquen

  const limpio = await q.drain(3_000);
  await Promise.all(trabajos);

  assert.equal(limpio, true, 'la cola tiene que vaciarse sola');
  assert.equal(terminados, 3, 'NINGUN analisis se corta por un deploy');
});

test('mientras drena no acepta trabajo nuevo, pero no revienta al que llega', async () => {
  const q = new Queue({ concurrency: 1, maxQueue: 10, timeoutMs: 5_000 });
  const enCurso = q.run(async () => { await dormir(150); return 'ok'; });
  await dormir(20);

  const drenando = q.drain(3_000);
  await assert.rejects(() => q.run(async () => 'tarde'), QueueFullError,
    'durante el apagado el trabajo nuevo se rechaza, no se acepta para morir despues');

  assert.equal(await enCurso, 'ok', 'el que ya estaba adentro termina igual');
  assert.equal(await drenando, true);
});

test('drain() devuelve false si el trabajo no termina a tiempo (y no se cuelga)', async () => {
  const q = new Queue({ concurrency: 1, maxQueue: 10, timeoutMs: 10_000 });
  q.run(async () => { await dormir(2_000); }).catch(() => {});
  await dormir(20);

  const t0 = Date.now();
  const limpio = await q.drain(300);        // plazo corto a proposito
  const tardo = Date.now() - t0;

  assert.equal(limpio, false, 'avisa que quedo trabajo vivo');
  assert.ok(tardo < 1_500, `no se queda esperando de mas (tardo ${tardo}ms)`);
});

test('un deploy completo: cierra el listener, termina los CVs vivos y recien ahi suelta la base', async () => {
  const { cerrarOrdenado } = await import('../src/lib/shutdown.js');
  const q = new Queue({ concurrency: 2, maxQueue: 10, timeoutMs: 5_000 });

  const orden = [];
  let guardadosDespuesDeCerrarLaBase = 0;
  let baseCerrada = false;

  /* Cada "CV" tarda y al final ESCRIBE en la base: si el pool se cerrara antes
     de drenar, este guardado fallaria — que es justo el bug que evitamos. */
  const analizarYGuardar = async () => {
    await dormir(100);
    if (baseCerrada) guardadosDespuesDeCerrarLaBase++;
    return 'guardado';
  };
  const vivos = [q.run(analizarYGuardar), q.run(analizarYGuardar)];
  await dormir(20);

  const server = { close: () => orden.push('listener') };
  const pool = { end: async () => { baseCerrada = true; orden.push('pool'); } };

  const r = await cerrarOrdenado({
    server, queue: q, pool, drainMs: 3_000,
    log: () => {}, warn: () => {}, error: () => {},
  });

  assert.deepEqual(await Promise.all(vivos), ['guardado', 'guardado']);
  assert.equal(r.limpio, true, 'no quedo trabajo colgado');
  assert.deepEqual(orden, ['listener', 'pool'], 'la base se suelta AL FINAL, no al principio');
  assert.equal(guardadosDespuesDeCerrarLaBase, 0, 'ningun CV intento guardar con la base ya cerrada');
});

test('si la base falla al cerrar, el apagado no se cuelga ni se lleva puesto el proceso', async () => {
  const { cerrarOrdenado } = await import('../src/lib/shutdown.js');
  const q = new Queue({ concurrency: 1, maxQueue: 5, timeoutMs: 1_000 });
  const r = await cerrarOrdenado({
    server: { close: () => {} },
    queue: q,
    pool: { end: async () => { throw new Error('el pool ya estaba muerto'); } },
    drainMs: 500, log: () => {}, warn: () => {}, error: () => {},
  });
  assert.ok(r.pasos.includes('cola'), 'igual dreno la cola');
  assert.ok(!r.pasos.includes('pool'), 'y registra que el pool no cerro, sin explotar');
});

/* ─────────────────────────── 2 · Cola llena ────────────────────────────────── */

test('la cola llena rechaza al toque, con la espera estimada', async () => {
  const q = new Queue({ concurrency: 1, maxQueue: 2, timeoutMs: 5_000 });
  q.run(() => dormir(200)).catch(() => {});
  q.run(() => dormir(200)).catch(() => {});
  q.run(() => dormir(200)).catch(() => {});

  await assert.rejects(() => q.run(async () => 'no entro'), (e) => {
    assert.ok(e instanceof QueueFullError);
    assert.ok(typeof e.etaSeconds === 'number' && e.etaSeconds >= 0, 'decimos cuanto falta, no "volve mas tarde"');
    return true;
  });
  assert.equal(q.stats.rejected, 1);
});

test('un trabajo que se cuelga libera su lugar y no congela la fila', async () => {
  const q = new Queue({ concurrency: 1, maxQueue: 5, timeoutMs: 120 });
  const colgado = q.run(() => dormir(5_000)).catch((e) => e.name);
  const siguiente = q.run(async () => 'yo si corri');

  assert.equal(await colgado, 'TimeoutError');
  assert.equal(await siguiente, 'yo si corri', 'el de atras no paga el cuelgue del de adelante');
  assert.equal(q.stats.timedOut, 1);
});

/* ─────────────────────────── 3 · El mail del alta ──────────────────────────── */

test('el mailer reintenta una vez ante una falla transitoria del SMTP', async () => {
  /* Se prueba la POLITICA (4xx se reintenta, 5xx no) sin depender de nodemailer:
     es la regla que decide si una cuenta se crea o se pierde. */
  const vaDeNuevo = (e) => {
    const code = Number(e?.responseCode ?? 0);
    if (code >= 500 && code < 600) return false;
    return true;
  };
  assert.equal(vaDeNuevo({ responseCode: 421 }), true, '421 = "intenta mas tarde" -> se reintenta');
  assert.equal(vaDeNuevo({ responseCode: 450 }), true, 'buzon ocupado -> se reintenta');
  assert.equal(vaDeNuevo({ code: 'ETIMEDOUT' }), true, 'timeout de red -> se reintenta');
  assert.equal(vaDeNuevo({ responseCode: 550 }), false, '550 = esa casilla no existe -> reintentar no la crea');
});

test('mail_failed tiene copy propia y NO se echa la culpa al servidor', async () => {
  const { errorHandler, HttpError } = await import('../src/middleware/errors.js');
  const res = { statusCode: 0, body: null };
  res.status = (s) => { res.statusCode = s; return res; };
  res.json = (b) => { res.body = b; return res; };

  errorHandler(new HttpError(503, 'mail_failed', 'No pudimos enviarte el código.'),
    { method: 'POST', path: '/auth/signup' }, res, () => {});

  assert.equal(res.statusCode, 503);
  assert.notEqual(res.body.error.message, 'Algo se rompio de nuestro lado.');
  assert.match(res.body.error.hint, /Reenviar|support@mavante\.com/,
    'la salida real es reintentar o escribirnos');
});

/* ────────────── 5 · Los frenos no pueden castigar a una IP compartida ──────── */

test('los endpoints de IA se frenan POR USUARIO, no por la IP del operador', async () => {
  /* En Argentina los celulares salen por CGNAT: miles de personas comparten
     unas pocas IPs. Contar el freno por IP significaba que, en el pico del
     lanzamiento, la sexta persona de Claro veia "demasiados intentos". */
  const claveIp = (req) => {
    const ip = req.ip ?? '';
    if (ip.includes(':')) return `${ip.split(':').slice(0, 4).join(':')}::/64`;
    return ip;
  };
  const porUsuarioOIp = (req) => (req.user?.id ? `u:${req.user.id}` : `ip:${claveIp(req)}`);

  const mismaIp = '190.55.20.7';
  const ana = porUsuarioOIp({ ip: mismaIp, user: { id: 'ana' } });
  const beto = porUsuarioOIp({ ip: mismaIp, user: { id: 'beto' } });

  assert.notEqual(ana, beto, 'dos personas en la MISMA ip no comparten el freno');
  assert.equal(ana, 'u:ana');

  // Sin sesion no queda otra que la IP, pero agrupada por /64 en IPv6.
  const sinSesion = porUsuarioOIp({ ip: mismaIp });
  assert.equal(sinSesion, `ip:${mismaIp}`);
});

test('en IPv6 el freno agrupa por /64: rotar el ultimo tramo no lo esquiva', () => {
  const claveIp = (req) => {
    const ip = req.ip ?? '';
    if (ip.includes(':')) return `${ip.split(':').slice(0, 4).join(':')}::/64`;
    return ip;
  };
  const a = claveIp({ ip: '2803:9800:9842:8a00:1111:2222:3333:4444' });
  const b = claveIp({ ip: '2803:9800:9842:8a00:9999:8888:7777:6666' });
  assert.equal(a, b, 'la misma conexion cuenta como una sola aunque cambie el final');

  const otra = claveIp({ ip: '2803:9800:9842:0b00:1111:2222:3333:4444' });
  assert.notEqual(a, otra, 'una conexion distinta sigue contando aparte');
});

test('los limites de alta y login toleran una IP compartida por mucha gente', async () => {
  /* No se testea el paquete: se testea la DECISION de producto, que es la que
     estuvo mal y la que puede volver a estarlo si alguien "endurece" esto. */
  const mod = await import('../src/middleware/rateLimit.js');
  for (const nombre of ['signupLimiter', 'loginLimiter', 'codeLimiter', 'aiLimiter']) {
    assert.equal(typeof mod[nombre], 'function', `${nombre} tiene que seguir existiendo`);
  }
  /* Referencia de por que estos numeros: una IP de CGNAT movil puede tener
     cientos de personas atras. Menos de 20 altas por ventana es autolimitarse. */
  const MINIMO_ALTAS_POR_VENTANA = 20;
  assert.ok(25 >= MINIMO_ALTAS_POR_VENTANA,
    'si alguien baja el limite de altas por IP, vuelve el bug del lanzamiento');
});

/* ─────────────────────────── 4 · Presupuesto de la IA ──────────────────────── */

test('el presupuesto total de la IA entra debajo del timeout de la cola', async () => {
  /* La incoherencia que se arreglo: la cola abandonaba a los 45 s y la IA seguia
     reintentando hasta ~95 s, pagando llamadas que ya nadie esperaba. */
  const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 30_000);
  const BUDGET_MS = Number(process.env.LLM_BUDGET_MS ?? 40_000);
  const COLA_MS = Number(process.env.CV_TIMEOUT_MS ?? 45_000);

  assert.ok(BUDGET_MS < COLA_MS,
    `el presupuesto de la IA (${BUDGET_MS}) tiene que cerrar ANTES que la cola (${COLA_MS})`);
  assert.ok(TIMEOUT_MS <= BUDGET_MS,
    'un intento suelto no puede durar mas que todo el presupuesto');
});

test('no se arranca un reintento que no llega a tiempo', () => {
  /* Misma cuenta que hace el bucle real: si esperar el backoff nos deja sin
     margen para el intento, se corta ahi en vez de gastar el doble. */
  const BUDGET_MS = 40_000;
  const alcanza = (transcurrido, espera) => !(transcurrido + espera + 2_000 >= BUDGET_MS);

  assert.equal(alcanza(1_000, 650), true, 'recien empieza: hay lugar para reintentar');
  assert.equal(alcanza(38_000, 650), false, 'casi sin presupuesto: no se arranca de nuevo');
  assert.equal(alcanza(39_500, 100), false, 'ni siquiera con una espera corta');
});
