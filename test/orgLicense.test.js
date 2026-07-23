import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dominioAutorizado, dominioDeEmail, motivoDeRechazo, normalizarCodigo } from '../src/lib/orgLicense.js';

const DIA = 24 * 60 * 60 * 1000;
const licencia = (extra = {}) => ({
  id: 'lic-1',
  code: 'UDESA2026',
  name: 'Universidad de San Andrés',
  email_domain: null,
  max_users: 200,
  valid_until: new Date(Date.now() + 90 * DIA),
  is_active: true,
  ...extra,
});

test('el código se compara sin depender de mayúsculas ni espacios', () => {
  // se dicta por teléfono y se copia de un PDF: llega como llega
  assert.equal(normalizarCodigo('  udesa 2026 '), 'UDESA2026');
  assert.equal(normalizarCodigo('UDESA2026'), 'UDESA2026');
  assert.equal(normalizarCodigo(null), '');
});

test('el dominio sale del email y aguanta basura', () => {
  assert.equal(dominioDeEmail('Ana@UDESA.edu.ar'), 'udesa.edu.ar');
  assert.equal(dominioDeEmail('sin-arroba'), '');
  assert.equal(dominioDeEmail(undefined), '');
});

test('sin dominio configurado, el código vale para cualquiera', () => {
  assert.ok(dominioAutorizado('cualquiera@gmail.com', null));
  assert.ok(dominioAutorizado('cualquiera@gmail.com', ''));
});

test('con dominio, entran también los subdominios de la institución', () => {
  assert.ok(dominioAutorizado('ana@udesa.edu.ar', 'udesa.edu.ar'));
  assert.ok(dominioAutorizado('ana@alumnos.udesa.edu.ar', 'udesa.edu.ar'));
  assert.ok(dominioAutorizado('ana@udesa.edu.ar', '@udesa.edu.ar'));   // con arroba de más
  assert.ok(!dominioAutorizado('ana@gmail.com', 'udesa.edu.ar'));
});

test('un dominio parecido NO entra (no alcanza con terminar igual)', () => {
  // el bug clásico: endsWith sin el punto deja pasar "falsoudesa.edu.ar"
  assert.ok(!dominioAutorizado('ana@falsoudesa.edu.ar', 'udesa.edu.ar'));
});

test('canje válido: no hay motivo de rechazo', () => {
  assert.equal(motivoDeRechazo(licencia(), { usados: 10, email: 'ana@gmail.com' }), null);
});

test('código inexistente o apagado', () => {
  assert.equal(motivoDeRechazo(null, {}).code, 'license_unknown');
  assert.equal(motivoDeRechazo(licencia({ is_active: false }), {}).code, 'license_unknown');
});

test('licencia vencida: el contrato terminó', () => {
  const r = motivoDeRechazo(licencia({ valid_until: new Date(Date.now() - DIA) }), { email: 'a@b.com' });
  assert.equal(r.code, 'license_expired');
});

test('fecha ilegible se trata como vencida, no como permiso', () => {
  const r = motivoDeRechazo(licencia({ valid_until: 'cualquier cosa' }), { email: 'a@b.com' });
  assert.equal(r.code, 'license_expired');
});

test('email de otro dominio: el mensaje dice con qué cuenta entrar', () => {
  const r = motivoDeRechazo(licencia({ email_domain: 'udesa.edu.ar' }), { email: 'ana@gmail.com' });
  assert.equal(r.code, 'license_domain');
  assert.match(r.message, /udesa\.edu\.ar/);
});

test('cupo lleno', () => {
  const r = motivoDeRechazo(licencia({ max_users: 2 }), { usados: 2, email: 'a@b.com' });
  assert.equal(r.code, 'license_full');
});

test('quien YA canjeó puede reintentar aunque el cupo esté lleno', () => {
  /* Pasa de verdad: la persona no ve el cambio y vuelve a apretar. Rechazarla
     por "cupo lleno" cuando ella es uno de los que lo llenan es absurdo. */
  const r = motivoDeRechazo(licencia({ max_users: 2 }), { usados: 2, email: 'a@b.com', yaEsMiembro: true });
  assert.equal(r, null);
});

test('el dominio se revisa ANTES que el cupo', () => {
  // si el código no era para vos, cuánta gente lo usó no te sirve de nada
  const r = motivoDeRechazo(licencia({ email_domain: 'udesa.edu.ar', max_users: 1 }), {
    usados: 5, email: 'ana@gmail.com',
  });
  assert.equal(r.code, 'license_domain');
});

test('ninguna negativa deja a la persona sin saber qué hacer', () => {
  const casos = [
    motivoDeRechazo(null, {}),
    motivoDeRechazo(licencia({ valid_until: new Date(Date.now() - DIA) }), { email: 'a@b.com' }),
    motivoDeRechazo(licencia({ email_domain: 'udesa.edu.ar' }), { email: 'ana@gmail.com' }),
    motivoDeRechazo(licencia({ max_users: 1 }), { usados: 1, email: 'a@b.com' }),
  ];
  for (const c of casos) {
    assert.ok(c.message.length > 20, 'el mensaje explica qué pasó');
    assert.ok(!/error|internal/i.test(c.message), 'no le echa la culpa a un fallo nuestro');
  }
});
