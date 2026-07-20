/**
 * test/anon.test.js
 *
 * El perfil que ve una empresa. Acá un bug no es un número mal calculado: es el
 * teléfono de una persona desempleada apareciendo en la pantalla de alguien que
 * no debería tenerlo.
 *
 * Por eso los tests son ADVERSARIOS: no comprueban que los campos buenos estén,
 * comprueban que los datos personales NO estén — buscándolos en el JSON entero,
 * venga por donde venga.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { perfilAnonimo, contactoRevelado, scrubText, looksLikeContact } from '../src/lib/anon.js';

/* Un CV realista, con los datos de contacto metidos en TODOS lados: en su campo
   propio, en el resumen y en una viñeta. Así es como llegan de verdad. */
const FILA = { id: 'uuid-1234', name: 'Ana Gómez', email: 'ana.gomez@gmail.com', visible_since: '2026-07-20T00:00:00Z' };
const CV = {
  name: 'Ana Gómez',
  contact: {
    email: 'ana.gomez@gmail.com',
    phone: '+54 9 11 5555-4433',
    linkedin: 'https://linkedin.com/in/anagomez',
    github: 'https://github.com/anagomez',
    website: 'anagomez.dev',
    location: 'Buenos Aires',
  },
  summary: 'Backend con 6 años. Escribime a ana.gomez@gmail.com o al +54 9 11 5555-4433.',
  experience: [
    {
      role: 'Backend Senior', company: 'Mercado Libre', location: 'CABA', dates: '2021-2024',
      bullets: ['Reduje la latencia 30%', 'Mi portfolio: anagomez.dev/proyectos', 'Contacto: @anagomez'],
    },
  ],
  education: [{ degree: 'Ing. en Informática', school: 'UBA', dates: '2015-2020' }],
  skills: ['Node.js', 'PostgreSQL', 'AWS'],
  languages: ['Español', 'Inglés B2'],
};

/* Todo lo que NO puede aparecer, en cualquier forma. */
const PROHIBIDO = [
  'Ana Gómez', 'ana.gomez@gmail.com', '5555-4433', '5555', 'linkedin.com/in/anagomez',
  'github.com/anagomez', 'anagomez.dev', '@anagomez', 'Mercado Libre', 'UBA',
];

test('el perfil anonimo NO contiene NINGUN dato personal, lo busque donde lo busque', () => {
  const json = JSON.stringify(perfilAnonimo(FILA, CV));
  const filtrados = PROHIBIDO.filter((x) => json.includes(x));
  assert.deepEqual(filtrados, [], `se filtraron datos personales: ${filtrados.join(', ')}`);
});

test('lista BLANCA: un campo nuevo en el CV no se publica solo', () => {
  /* Este es el test que justifica todo el diseño. Si el perfil se armara
     BORRANDO campos, este `dni` saldria publicado y nadie se enteraria. */
  const cvConCampoNuevo = { ...CV, dni: '30.123.456', twitter: '@ana', salaryExpectation: 'USD 5000' };
  const json = JSON.stringify(perfilAnonimo(FILA, cvConCampoNuevo));
  assert.ok(!json.includes('30.123.456'), 'un campo nuevo del CV se publico sin que nadie lo autorizara');
  assert.ok(!json.includes('USD 5000'));
  assert.ok(!json.includes('twitter'));
});

test('lo que SI se muestra alcanza para evaluar a la persona', () => {
  const p = perfilAnonimo(FILA, CV);
  assert.equal(p.headline, 'Backend Senior');
  assert.deepEqual(p.skills, ['Node.js', 'PostgreSQL', 'AWS']);
  assert.equal(p.yearsExperience, 5, 'de 2021 a 2026');
  assert.equal(p.experience[0].years, '2021–2024');
  assert.match(p.experience[0].bullets[0], /latencia 30%/, 'el LOGRO con su numero sobrevive');
  assert.equal(p.education[0].degree, 'Ing. en Informática');
  assert.equal(p.profileId, 'uuid-1234');
});

test('el nombre de la empresa y la universidad se ocultan: identifican a la persona', () => {
  /* "Backend en Mercado Libre 2021-2024" + "UBA" ubica a alguien con dos
     busquedas en LinkedIn. Anonimo tiene que significar anonimo. */
  const p = perfilAnonimo(FILA, CV);
  assert.equal(p.experience[0].company, undefined);
  assert.equal(p.education[0].school, undefined);
});

test('los contactos escondidos en TEXTO LIBRE se tapan', () => {
  const p = perfilAnonimo(FILA, CV);
  assert.ok(!p.summary.includes('@gmail.com'), 'el mail del resumen quedo a la vista');
  assert.ok(!p.summary.includes('5555'), 'el telefono del resumen quedo a la vista');
  assert.match(p.summary, /Backend con 6 años/, 'pero el contenido util se conserva');
  const vinetas = p.experience[0].bullets.join(' ');
  assert.ok(!vinetas.includes('anagomez.dev'), 'un link en una viñeta quedo a la vista');
  assert.ok(!vinetas.includes('@anagomez'), 'un usuario de red en una viñeta quedo a la vista');
});

test('scrubText no destroza lo que un CV necesita decir', () => {
  /* El limpiador tiene que ser agresivo con los contactos y MANSO con lo demas:
     si borra los numeros de los logros, destruye justo lo que hace bueno a un CV. */
  assert.equal(scrubText('Crecí el revenue 45% en 2023'), 'Crecí el revenue 45% en 2023');
  assert.equal(scrubText('Equipo de 12 personas, 3 países'), 'Equipo de 12 personas, 3 países');
  assert.match(scrubText('Node.js y React'), /Node\.js y React/);
  assert.match(scrubText('escribime a x@y.com'), /\[contacto oculto\]/);
});

test('looksLikeContact sirve para AVISARLE al usuario antes de publicarse', () => {
  assert.equal(looksLikeContact('Mi mail es ana@x.com'), true);
  assert.equal(looksLikeContact('Reduje la latencia 30%'), false);
  assert.equal(looksLikeContact('Lideré un equipo de 8'), false);
});

test('el contacto revelado SOLO se arma cuando alguien decidio destaparse', () => {
  /* Esta funcion no decide nada: la decision vive en la base (status=accepted).
     Lo que se prueba es que, cuando SE llama, entrega lo que corresponde. */
  const c = contactoRevelado(FILA, CV);
  assert.equal(c.name, 'Ana Gómez');
  assert.equal(c.email, 'ana.gomez@gmail.com');
  assert.equal(c.phone, '+54 9 11 5555-4433');
  assert.equal(c.links.length, 3);
});

test('un CV vacio o roto no revienta ni inventa datos', () => {
  for (const basura of [null, undefined, {}, { experience: null, skills: 'no-es-array' }]) {
    const p = perfilAnonimo({ id: 'x' }, basura);
    assert.equal(p.profileId, 'x');
    assert.ok(Array.isArray(p.skills));
    assert.ok(Array.isArray(p.experience));
  }
});
