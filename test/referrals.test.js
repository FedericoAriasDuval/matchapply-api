// =====================================================================
// REFERIDOS — lo que se puede probar sin base de datos.
//
// Las reglas antifraude (no autoinvitarse, un invitado paga una sola vez)
// viven en CONSTRAINTS de Postgres, no en JavaScript, y eso es a propósito:
// una regla en el código se puede saltear llamando a otra función; una regla
// en la base no se puede saltear de ninguna manera. Por eso no las testeo acá
// — las garantiza el motor, que es mejor testeador que yo.
//
// Lo que sí testeo es el generador de códigos, porque ahí hice dos promesas
// concretas en los comentarios y las promesas hay que verificarlas.
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newCode, ALPHABET } from '../src/lib/refcode.js';

test('el código no usa caracteres ambiguos', () => {
  // La promesa: "la gente dicta estos códigos por teléfono".
  // 0/O, 1/I/l se confunden al dictar y al escribir a mano.
  for (const c of '01OIL') assert.ok(!ALPHABET.includes(c), `el alfabeto contiene ${c}`);
});

test('el código tiene 7 caracteres del alfabeto, siempre', () => {
  for (let i = 0; i < 2000; i++) {
    const c = newCode();
    assert.equal(c.length, 7);
    for (const ch of c) assert.ok(ALPHABET.includes(ch), `carácter fuera del alfabeto: ${ch}`);
  }
});

test('los códigos no se repiten en 20.000 tiradas', () => {
  // No prueba que sea imposible colisionar (no lo es): prueba que el generador
  // no está sesgado hacia un puñado de valores, que sería el bug real.
  const seen = new Set();
  for (let i = 0; i < 20_000; i++) seen.add(newCode());
  assert.ok(seen.size > 19_990, `demasiadas colisiones: ${20_000 - seen.size}`);
});

test('el código no filtra nada del usuario', () => {
  // La promesa: "derivarlo del id o del email haría que un link público filtre
  // datos de quien lo comparte". Si el código fuera derivado, dos llamadas
  // seguidas darían lo mismo. Es aleatorio: no lo dan.
  assert.notEqual(newCode(), newCode());
});

test('todos los caracteres del alfabeto son alcanzables', () => {
  // Un `% ALPHABET.length` mal hecho puede dejar caracteres muertos.
  const seen = new Set();
  for (let i = 0; i < 50_000; i++) for (const ch of newCode()) seen.add(ch);
  assert.equal(seen.size, ALPHABET.length, 'hay caracteres que nunca salen');
});
