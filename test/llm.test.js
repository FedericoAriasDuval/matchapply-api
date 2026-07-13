import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractJson } from '../src/lib/json.js';

test('extrae el JSON aunque venga con markdown o texto alrededor', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Acá tenés: {"a":{"b":[1,2]}} listo.'), { a: { b: [1, 2] } });
});

test('no se confunde con llaves dentro de strings', () => {
  assert.deepEqual(extractJson('{"a":"}{ raro","b":2}'), { a: '}{ raro', b: 2 });
});

test('falla limpio si no hay JSON', () => {
  assert.throws(() => extractJson('sin json aquí'), /JSON/);
});
