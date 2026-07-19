/**
 * test/cvIlegible.test.js
 *
 * Qué pasa cuando un CV guardado NO se puede descifrar (clave rotada, fila
 * corrupta, backup viejo restaurado).
 *
 * LA HISTORIA, porque explica por qué este test existe:
 * el descifrado antes tiraba una excepción y salía un 500. Se "arregló"
 * haciendo que devolviera null... y ese null siguió viaje como si fuera el CV.
 * Seis handlers distintos hacían `doc.data.algo` y reventaban igual con un 500,
 * solo que ahora sin decir por qué. Un arreglo que mueve el problema de lugar es
 * peor que el problema, porque además lo esconde.
 *
 * La regla que se protege acá: una fila ilegible se descarta EN EL PORTÓN
 * (`readCvRow`), una sola vez, y nunca llega en forma de null a un handler.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

/* El módulo lee la config al importarse: hay que setear el entorno ANTES. */
process.env.CV_ENC_KEY = crypto.randomBytes(32).toString('hex');
process.env.DATABASE_URL = 'postgres://nadie:nadie@127.0.0.1:1/nada';
process.env.JWT_SECRET = 'solo-para-tests';

const { encryptJson } = await import('../src/lib/crypto.js');
const { readCvRow } = await import('../src/routes/cv.js');

const CV = { name: 'Ana Gómez', experience: [], education: [], skills: [], warnings: [] };

test('una fila sana se descifra y NUNCA devuelve el texto original hacia afuera', () => {
  const doc = readCvRow({ id: 'abc', lang: 'es', data: encryptJson(CV), source_text: 'texto crudo' });
  assert.equal(doc.data.name, 'Ana Gómez');
  assert.equal(doc.source_text, undefined, 'el CV en texto plano no sale del backend');
});

test('una fila ILEGIBLE devuelve null, no un objeto con data en null', () => {
  /* Este es el bug: si devolviera {data:null}, el handler haría doc.data.name
     y se caeria con un 500 generico en vez de contestar algo util. */
  const doc = readCvRow({ id: 'abc', lang: 'es', data: 'esto-no-es-un-cifrado-valido' });
  assert.equal(doc, null, 'la fila ilegible se descarta en el porton');
});

test('descifrar con OTRA clave tampoco explota: devuelve null', async () => {
  /* El escenario real: se rota CV_ENC_KEY y las filas viejas quedan huerfanas. */
  const cifradoConLaClaveVieja = encryptJson(CV);
  const otra = crypto.randomBytes(32).toString('hex');
  process.env.CV_ENC_KEY = otra;
  /* Se reimporta el modulo de crypto con la clave nueva usando una query string
     distinta, que es como Node fuerza una instancia limpia. */
  const cryptoNuevo = await import(`../src/lib/crypto.js?clave=${otra}`);
  assert.equal(cryptoNuevo.decryptJson(cifradoConLaClaveVieja), null,
    'con la clave cambiada el dato viejo no se lee, pero tampoco tira');
});

test('null y undefined pasan derecho, sin inventar un CV vacio', () => {
  assert.equal(readCvRow(null), null);
  assert.equal(readCvRow(undefined), undefined);
});
