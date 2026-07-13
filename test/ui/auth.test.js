/**
 * Flujos críticos de autenticación — los que se rompieron y no se pueden volver a romper.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boot } from './dom.js';

test('login: el botón NO se deshabilita al escribir la contraseña (regresión del bug)', () => {
  const { ctx, get, run } = boot();
  run("openAuth('login')");
  get('auEmail').value = 'fede@mail.com';
  get('auPass').value = 'miclave';
  ctx.pwCheck();
  assert.equal(get('auGo').disabled, false, 'el botón Continuar debe quedar habilitado en el login');
});

test('registro: el botón permanece bloqueado hasta cumplir las 5 reglas y confirmar', () => {
  const { ctx, get, run } = boot();
  run("openAuth('register')");

  get('auPass').value = 'corta';
  get('auPass2').value = 'corta';
  ctx.pwCheck();
  assert.equal(get('auGo').disabled, true, 'contraseña débil → bloqueado');

  get('auPass').value = 'Segura2026!';
  get('auPass2').value = 'Segura2026';   // no coincide
  ctx.pwCheck();
  assert.equal(get('auGo').disabled, true, 'sin coincidencia → bloqueado');

  get('auPass2').value = 'Segura2026!';
  ctx.pwCheck();
  assert.equal(get('auGo').disabled, false, 'fuerte y confirmada → habilitado');
});

test('ojo de contraseña: alterna password ⇄ text y vuelve a ocultar', () => {
  const { ctx, get, run } = boot();
  run("openAuth('register')");
  const input = get('auPass');
  input.type = 'password';

  ctx.togglePw('auPass');
  assert.equal(input.type, 'text', 'primer clic → visible');
  assert.ok(get('eye_auPass').classList.contains('on'));

  ctx.togglePw('auPass');
  assert.equal(input.type, 'password', 'segundo clic → oculta de nuevo');
  assert.equal(get('eye_auPass').classList.contains('on'), false);
});

test('las contraseñas nacen ocultas en cada render del formulario', () => {
  const { get, run } = boot();
  run("openAuth('register')");
  assert.equal(get('auPass').type, 'password');
  assert.equal(get('auPass2').type, 'password');
});

test('navegación login ⇄ registro: cambia el modo y no se traba con clics repetidos', async () => {
  const { mount, run } = boot();
  run("openAuth('login')");
  assert.equal(run('authMode'), 'login');

  // el modal ya está en pantalla: el cambio de formulario es animado (swap del cuerpo)
  mount('authBody');
  run("openAuth('register')");
  run("openAuth('register')"); // clic repetido durante la transición: debe ignorarse
  run("openAuth('login')");    // y no encolar un swap contradictorio

  await new Promise((r) => setTimeout(r, 300));
  assert.equal(run('authMode'), 'register', 'el swap en curso completa sin trabarse');
  assert.equal(run('_authSwapping'), false, 'el candado siempre se libera');
});

test('el email inválido no avanza y muestra un error visible (no congela la pantalla)', async () => {
  const { ctx, get, run } = boot();
  run("openAuth('login')");
  get('auEmail').value = 'no-es-un-email';
  get('auPass').value = 'algo';
  await ctx.doAuth();
  assert.equal(run('USER'), null, 'no se crea sesión');
  assert.ok(get('authErr').textContent.length > 0, 'se muestra el mensaje de error');
});
