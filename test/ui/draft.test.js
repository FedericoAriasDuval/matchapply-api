/**
 * Auto-guardado y recuperación de progreso.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boot } from './dom.js';

test('restaura el CV que el usuario estaba escribiendo tras un refresh', async () => {
  const storage = {
    ma_draft: JSON.stringify({
      profile: 'Federico Arias Duval\nAnalista de Datos con 3 años de experiencia.',
      reader: 'bot',
      tab: 'analysis',
      lang: 'es',
      at: Date.now() - 5 * 60_000,
    }),
  };
  const { ctx, get, run } = boot({ profile: '', storage });
  await ctx.Draft.init();

  assert.match(get('profile').value, /Federico Arias Duval/, 'el texto vuelve a la pantalla');
  assert.equal(run('currentReader'), 'bot', 'y también el evaluador elegido');
});

test('no pisa lo que el usuario ya tiene escrito', async () => {
  const storage = { ma_draft: JSON.stringify({ profile: 'BORRADOR VIEJO', at: Date.now() }) };
  const { ctx, get } = boot({ profile: 'TEXTO ACTUAL DEL USUARIO', storage });
  await ctx.Draft.init();
  assert.equal(get('profile').value, 'TEXTO ACTUAL DEL USUARIO');
});

test('guarda el estado en localStorage', async () => {
  const storage = {};
  const { ctx, get } = boot({ profile: '', storage });
  await ctx.Draft.init();
  get('profile').value = 'CV nuevo del usuario';
  ctx.Draft.save();

  const saved = JSON.parse(storage.ma_draft);
  assert.equal(saved.profile, 'CV nuevo del usuario');
  assert.ok(saved.at > 0);
});
