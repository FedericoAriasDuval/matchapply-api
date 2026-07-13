import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contactLine, dateRange, sanitizeCv } from '../src/lib/cvSchema.js';

/** Salida "sucia" típica de un modelo distraído: datos cruzados entre secciones. */
const dirty = {
  name: 'Ana Ruiz',
  contact: {
    email: 'ana.ruiz@mail.com',
    phone: '+54 11 3333-4444',
    linkedin: 'linkedin.com/in/anaruiz',
    github: '',
    website: 'Licenciatura en Marketing',      // basura: no es un sitio
    location: 'Buenos Aires, Argentina',
  },
  summary: 'Analista de marketing con foco en performance.',
  summary_is_generated: false,
  experience: [
    {
      role: 'Analista de Marketing',
      company: 'Bright Ads',
      location: 'Buenos Aires, Argentina',
      start: '2022',
      end: 'present',
      bullets: [
        'Gestioné campañas de SEM y bajé el costo por lead un 25%.',
        'SEO, Google Analytics, HubSpot',                       // skills coladas
        'Intereses: fotografía y ciclismo',                     // intereses colados
        'ana.ruiz@mail.com',                                    // contacto colado
        'Universidad de Palermo, Licenciatura en Marketing, 2017-2021', // educación colada
        'Gestioné campañas de SEM y bajé el costo por lead un 25%.',    // duplicado
      ],
    },
  ],
  education: [
    { institution: 'Universidad de Palermo', degree: 'Licenciatura en Marketing', location: 'Buenos Aires, Argentina', start: '2017', end: '2021' },
    { institution: '', degree: 'Me encantó la cursada y participé del centro de estudiantes durante tres años seguidos', location: '', start: '', end: '' },
  ],
  skills: ['SEO', 'SEM', 'Google Analytics', 'gestioné equipos de trabajo en varias campañas grandes', 'seo'],
  languages: ['Inglés avanzado'],
  interests: ['Fotografía', 'Ciclismo', 'Trabajé en Bright Ads desde 2022'],
  warnings: [],
};

test('experiencia: solo quedan logros profesionales', () => {
  const cv = sanitizeCv(dirty);
  assert.deepEqual(cv.experience[0].bullets, [
    'Gestioné campañas de SEM y bajé el costo por lead un 25%.',
  ]);
});

test('educación: se descartan los comentarios sin institución ni título', () => {
  const cv = sanitizeCv(dirty);
  assert.equal(cv.education.length, 1);
  assert.equal(cv.education[0].institution, 'Universidad de Palermo');
  assert.equal(cv.education[0].degree, 'Licenciatura en Marketing');
});

test('skills: términos, no frases; sin duplicados; con idiomas', () => {
  const cv = sanitizeCv(dirty);
  assert.deepEqual(cv.skills, ['SEO', 'SEM', 'Google Analytics', 'Inglés avanzado']);
});

test('intereses: sin fechas ni empresas', () => {
  const cv = sanitizeCv(dirty);
  assert.deepEqual(cv.interests, ['Fotografía', 'Ciclismo']);
});

test('contacto: se limpia lo que no es un canal de contacto', () => {
  const cv = sanitizeCv(dirty);
  assert.equal(cv.contact.email, 'ana.ruiz@mail.com');
  assert.equal(cv.contact.linkedin, 'linkedin.com/in/anaruiz');
  assert.ok(contactLine(cv).includes('|'));
});

test('nunca inventa: un CV vacío devuelve todo vacío', () => {
  const cv = sanitizeCv({});
  assert.equal(cv.name, '');
  assert.deepEqual(cv.experience, []);
  assert.deepEqual(cv.education, []);
  assert.deepEqual(cv.skills, []);
  assert.equal(cv.summary, '');
});

test('rango de fechas', () => {
  assert.equal(dateRange('2021', '2025'), '2021 – 2025');
  assert.equal(dateRange('2024', 'present'), '2024 – Present');
  assert.equal(dateRange('', ''), '');
});
