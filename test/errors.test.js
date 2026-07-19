/**
 * test/errors.test.js
 *
 * El manejador de errores le habla a una persona que ya viene golpeada por la
 * búsqueda laboral. La regla que estos tests protegen es una sola:
 *
 *   un error que es culpa del usuario (o simplemente su situación: no está
 *   logueado, no es Pro, se le acabó la cuota) JAMÁS puede decirle "algo se
 *   rompió de nuestro lado".
 *
 * Ese mensaje manda a esperar a alguien que solo tenía que apretar un botón.
 * Antes pasaba con 21 de los 34 códigos, porque el fallback del diccionario era
 * `internal_error` para cualquier código sin copy.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorHandler, HttpError, badRequest, forbidden, unauthorized, tooMany } from '../src/middleware/errors.js';

/* Un res de mentira: guarda status y body en vez de escribir en un socket. */
const fakeRes = () => {
  const res = { statusCode: 0, body: null };
  res.status = (s) => { res.statusCode = s; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};

const run = (err) => {
  const res = fakeRes();
  errorHandler(err, { method: 'GET', path: '/test' }, res, () => {});
  return res;
};

const CULPA_NUESTRA = 'Algo se rompio de nuestro lado.';

test('un 401 no se echa la culpa: le dice a la persona que inicie sesión', () => {
  const res = run(unauthorized());
  assert.equal(res.statusCode, 401);
  assert.notEqual(res.body.error.message, CULPA_NUESTRA);
  assert.match(res.body.error.hint, /sesion/i, 'el hint tiene que decir QUÉ hacer');
});

test('pro_required explica el límite sin sonar a falla técnica', () => {
  const res = run(forbidden('pro_required', 'Esta función es exclusiva de Mavante Pro.', { upgrade: true }));
  assert.equal(res.statusCode, 403);
  assert.notEqual(res.body.error.message, CULPA_NUESTRA);
  assert.equal(res.body.error.upgrade, true, 'el extra tiene que sobrevivir al handler');
});

test('quota_exceeded dice cuándo se renueva, no que se rompió algo', () => {
  const res = run(tooMany('quota_exceeded', 'Llegaste a tu límite diario.', { limit: 3 }));
  assert.equal(res.statusCode, 429);
  assert.notEqual(res.body.error.message, CULPA_NUESTRA);
  assert.equal(res.body.error.limit, 3);
});

test('un código NUEVO sin copy conserva su mensaje humano en vez de caer en internal_error', () => {
  /* Este es el test que importa a futuro: alguien agrega un código y se olvida
     del diccionario. Antes eso le mentía al usuario; ahora usa el mensaje que
     ya se escribió en el throw. */
  const res = run(badRequest('codigo_que_no_existe_todavia', 'Falta el puesto al que te postulás.'));
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.message, 'Falta el puesto al que te postulás.');
  assert.notEqual(res.body.error.message, CULPA_NUESTRA);
  assert.ok(res.body.error.hint, 'siempre hay una salida, aunque sea genérica');
});

test('un 500 SÍ se hace cargo, y no filtra el error real', () => {
  const res = run(new Error('connect ECONNREFUSED 10.0.0.1:5432 en la tabla users'));
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error.message, CULPA_NUESTRA);
  assert.doesNotMatch(JSON.stringify(res.body), /ECONNREFUSED|users|5432/, 'jamás sale la infra hacia afuera');
});

test('todo error trae un requestId corto para poder rastrearlo', () => {
  const res = run(new HttpError(400, 'invalid_payload', 'Datos incompletos.'));
  assert.match(res.body.error.requestId, /^[0-9a-f]{8}$/);
});

test('ningún 4xx del catálogo termina diciendo "se rompió de nuestro lado"', () => {
  /* Barrido: todos los códigos 4xx que existen hoy en las rutas. */
  const codigos4xx = [
    'account_locked', 'admin_only', 'already_verified', 'bad_format', 'cv_not_found',
    'cv_unparsable', 'empty_cv', 'interview_session', 'invalid_code', 'invalid_credentials',
    'invalid_cv', 'invalid_payload', 'no_file', 'not_found', 'not_verified',
    'password_mismatch', 'pro_required', 'quota_exceeded', 'resend_cooldown',
    'session_expired', 'token_invalid', 'unsupported_file', 'user_not_found',
    'weak_password', 'file_too_large',
  ];
  const culpables = codigos4xx.filter((code) => {
    const res = run(new HttpError(400, code, 'Mensaje humano del throw.'));
    return res.body.error.message === CULPA_NUESTRA;
  });
  assert.deepEqual(culpables, [], 'estos códigos le mienten al usuario');
});
