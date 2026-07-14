/**
 * test/crypto.test.js
 * El cifrado de los CVs. Si esto falla, la promesa de la web es mentira.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// La clave se lee al importar el modulo: hay que setearla ANTES.
process.env.CV_ENC_KEY = crypto.randomBytes(32).toString('hex');
const { encryptText, decryptText, encryptJson, decryptJson, encryptionEnabled, sha256 } =
  await import('../src/lib/crypto.js');

const CV = 'Federico Arias Duval\nfede@mail.com | +54 11 5555-5555\nDesarrollador Full Stack';

test('el cifrado esta activo cuando hay clave', () => {
  assert.equal(encryptionEnabled(), true);
});

test('ida y vuelta: lo que entra es lo que sale', () => {
  assert.equal(decryptText(encryptText(CV)), CV);
});

test('el CV cifrado es ILEGIBLE: no contiene ni el nombre ni el mail', () => {
  const enc = encryptText(CV);
  assert.ok(!enc.includes('Federico'), 'el nombre no puede aparecer');
  assert.ok(!enc.includes('fede@mail.com'), 'el mail no puede aparecer');
  assert.ok(!enc.includes('5555'), 'el telefono no puede aparecer');
  assert.ok(enc.startsWith('v1:'), 'va versionado, para poder rotar la clave manana');
});

test('dos cifrados del MISMO texto dan resultados distintos (IV aleatorio)', () => {
  const a = encryptText(CV), b = encryptText(CV);
  assert.notEqual(a, b, 'reusar el IV en GCM rompe el esquema entero');
  assert.equal(decryptText(a), decryptText(b));
});

test('si alguien altera un byte, el descifrado FALLA (no devuelve basura silenciosa)', () => {
  const enc = encryptText(CV);
  const partes = enc.split(':');
  const datos = Buffer.from(partes[3], 'base64');
  datos[0] ^= 0xff;                                  // un bit dado vuelta
  partes[3] = datos.toString('base64');
  assert.throws(() => decryptText(partes.join(':')), 'GCM tiene que detectar la manipulacion');
});

test('el JSON estructurado tambien se cifra', () => {
  const data = { name: 'Federico', experience: [{ role: 'Dev', bullets: ['Reduje 40%'] }] };
  const enc = encryptJson(data);
  assert.ok(!enc.includes('Federico'));
  assert.deepEqual(decryptJson(enc), data);
});

test('los CVs viejos en texto plano se siguen leyendo (migracion sin romper nada)', () => {
  assert.equal(decryptText('CV viejo sin cifrar'), 'CV viejo sin cifrar');
});

test('el hash se calcula sobre el texto PLANO: deduplica sin descifrar', () => {
  assert.equal(sha256(CV), sha256(CV));
  assert.notEqual(sha256(CV), sha256(CV + ' '));
  assert.equal(sha256(CV).length, 64);
});
