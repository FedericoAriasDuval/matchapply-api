import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contactLine, dateRange, normalizeLevel, sanitizeCv } from '../src/lib/cvSchema.js';
import { scrubCvText } from '../src/lib/cvPrompt.js';

test('scrubCvText: saca emojis de viñeta pero conserva el texto del CV', () => {
  const out = scrubCvText('ACERCA DE MÍ: 💼 Ejecutivo con 27 años. 🚀 P&L. 📩 mail@x.com');
  assert.equal(/\p{Extended_Pictographic}/u.test(out), false);            // sin emojis
  assert.ok(out.includes('Ejecutivo con 27 años'), out);                  // texto intacto
  assert.ok(out.includes('P&L') && out.includes('mail@x.com'), out);
});

test('scrubCvText: elimina surrogates sueltos y caracteres de control', () => {
  const roto = 'Hola\uD83D mun' + String.fromCharCode(0) + 'do' + String.fromCharCode(7) + ' fin';
  const out = scrubCvText(roto);
  assert.ok(!/[\uD800-\uDFFF]/.test(out), 'no debe quedar surrogate suelto');
  assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(out), 'no debe quedar control');
  assert.ok(out.includes('Hola') && out.includes('mundo') && out.includes('fin'), out);
});

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

test('skills: términos, no frases; sin duplicados; y SIN los idiomas', () => {
  /* Los idiomas salían acá adentro y el CV terminaba sin sección de idiomas.
     Ahora cada cosa en su lugar: habilidades acá, idiomas en cv.languages. */
  const cv = sanitizeCv(dirty);
  assert.deepEqual(cv.skills, ['SEO', 'SEM', 'Google Analytics']);
  assert.deepEqual(cv.languages, ['Inglés avanzado']);
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

test('normalizeLevel: aclaraciones informales entre paréntesis se profesionalizan', () => {
  assert.equal(normalizeLevel('Italiano (muy poco)'), 'Italiano (básico)');
  assert.equal(normalizeLevel('Inglés (un poco)'), 'Inglés (básico)');
  assert.equal(normalizeLevel('Excel (nivel usuario)'), 'Excel (básico)');
  assert.equal(normalizeLevel('Python (lo vi en un curso)'), 'Python (formación académica)');
  assert.equal(normalizeLevel('Alemán (visto en la facultad)'), 'Alemán (formación académica)');
  assert.equal(normalizeLevel('Inglés (medio oxidado)'), 'Inglés (intermedio)');
});

test('normalizeLevel: los intensificadores se sacan del nivel estándar', () => {
  assert.equal(normalizeLevel('Inglés (muy avanzado)'), 'Inglés (avanzado)');   // el caso que reportó Federico
  assert.equal(normalizeLevel('Excel (muy básico)'), 'Excel (básico)');
  assert.equal(normalizeLevel('Inglés (bastante avanzado)'), 'Inglés (avanzado)');
  assert.equal(normalizeLevel('Inglés (nivel avanzado)'), 'Inglés (avanzado)');   // "nivel" redundante fuera
});

test('normalizeLevel: NUNCA fabrica un código CEFR que el CV no escribió', () => {
  for (const s of ['Inglés (básico)', 'Italiano (muy poco)', 'Francés (un poco)']) {
    assert.ok(!/\b[ABC][12]\b/.test(normalizeLevel(s)), `no debería inventar CEFR en "${s}"`);
  }
});

test('normalizeLevel: la escala estándar de una palabra se respeta (sin inflar)', () => {
  assert.equal(normalizeLevel('Excel (básico)'), 'Excel (básico)');                 // ya es estándar: intacto
  assert.equal(normalizeLevel('Inglés (avanzado)'), 'Inglés (avanzado)');           // idem: no se toca
  assert.equal(normalizeLevel('Español (nativo)'), 'Español (nativo)');              // nativo se deja
  assert.equal(normalizeLevel('Inglés (nivel básico)'), 'Inglés (básico)');          // "nivel" redundante fuera
});

test('normalizeLevel: fuera de paréntesis NO toca nada (no es una aclaración)', () => {
  assert.equal(normalizeLevel('Cálculo básico'), 'Cálculo básico');                 // nombre de materia, intacto
  assert.equal(normalizeLevel('Marketing avanzado'), 'Marketing avanzado');
});

test('instituciones NO son skills ni idiomas (Hospital Francés / Italiano)', () => {
  const cv = sanitizeCv({
    ...dirty,
    // lo que devolvía el parser con el CV real: "Promoción y venta en
    // Hospitales Muñiz, Francés e Italiano de Buenos Aires"
    skills: ['SAP', 'Hospital Francés', 'Colegio Champagnat', 'Universidad de Palermo'],
    languages: ['Hospital Italiano', 'Instituto de Lengua Inglesa', 'Inglés avanzado'],
  });
  const s = JSON.stringify(cv.skills);
  assert.ok(!cv.skills.some((x) => /hospital/i.test(x)), 'ningún hospital en skills: ' + s);
  assert.ok(!cv.skills.some((x) => /colegio|universidad|instituto/i.test(x)), 'ninguna institución en skills: ' + s);
  // y lo que SÍ es una habilidad/idioma real se conserva, cada uno en su lugar
  assert.ok(cv.skills.includes('SAP'), s);
  assert.deepEqual(cv.languages, ['Inglés avanzado']);
  const l = JSON.stringify(cv.languages);
  assert.ok(!cv.languages.some((x) => /hospital|instituto/i.test(x)), 'ninguna institución en idiomas: ' + l);
});

test('sanitizeCv: normaliza niveles informales y una skill larga sobrevive al filtro', () => {
  const cv = sanitizeCv({
    ...dirty,
    skills: ['SEO', 'Python (lo vi en un curso)'],
    languages: ['Italiano (muy poco)', 'Inglés (medio oxidado)'],
  });
  // "Python (lo vi en un curso)" (6 palabras) se acorta a 3 y pasa el filtro
  assert.ok(cv.skills.includes('Python (formación académica)'), JSON.stringify(cv.skills));
  // los idiomas se normalizan igual, pero en SU sección
  assert.ok(cv.languages.includes('Italiano (básico)'), JSON.stringify(cv.languages));
  assert.ok(cv.languages.includes('Inglés (intermedio)'), JSON.stringify(cv.languages));
  // y jamás un CEFR inventado, en ninguna de las dos listas
  assert.ok(![...cv.skills, ...cv.languages].some((s) => /\b[ABC][12]\b/.test(s)));
});

/* ===== Revisión de robustez 23/07: la basura real que traen las plantillas ===== */

test('scrubCvText: los "iconos" de plantillas (fuente privada/PUA) desaparecen', () => {
  // el telefonito y el sobrecito de Canva llegan como glifos U+E000-F8FF
  const out = scrubCvText(' 11-5555-5555   ana@mail.com');
  assert.ok(!/[-]/.test(out), 'no debe quedar PUA');
  assert.ok(out.includes('11-5555-5555') && out.includes('ana@mail.com'), out);
});

test('scrubCvText: expande ligaduras tipográficas ("finanzas" con ligadura)', () => {
  const out = scrubCvText('ﬁnanzas y oﬃce management');
  assert.ok(out.includes('finanzas'), out);
  assert.ok(out.includes('office'), out);
});

test('scrubCvText: invisibles (bidi, ancho-cero, guion blando) y NBSP', () => {
  const out = scrubCvText('Ge­rente​ de Producto‬');
  assert.equal(out, 'Gerente de Producto');
});

test('scrubCvText: re-pega las versalitas partidas del PDF', () => {
  // caso real (CV del padre de Federico): la letra capital viene como item aparte
  const out = scrubCvText('M ARKETING C OUNTRY M ANAGER en G ERENTE DE P RODUCTO');
  assert.ok(out.includes('MARKETING COUNTRY MANAGER'), out);
  assert.ok(out.includes('GERENTE DE PRODUCTO'), out);
});

test('scrubCvText: NO pega palabras reales de una letra ("A CARGO", "Y VENTAS")', () => {
  const out = scrubCvText('A CARGO de marketing Y VENTAS, con O TRO equipo');
  assert.ok(out.includes('A CARGO'), out);      // "a" es palabra: no se toca
  assert.ok(out.includes('Y VENTAS'), out);     // "y" es palabra: no se toca
  assert.ok(out.includes('O TRO'), out);        // "o" es palabra: mejor no adivinar
});

test('scrubCvText: el texto de un CV normal pasa INTACTO (regresión)', () => {
  const normal = 'Carla Irina Blanco Rolon\nABOGADA\nExperiencia laboral\nEstudio Jurídico "Equality" (2023-2024)\n• Seguimiento de Agenda. Redacción de Demandas.\nUniversidad Nacional de La Plata';
  assert.equal(scrubCvText(normal), normal);
});

/* ===== IDIOMAS: sección propia, y NUNCA se pierden (23/07) =====
   El CV de Santino decía "IDIOMAS · Inglés - C2" y el CV generado salía sin una
   sola mención. La causa no era un filtro: sanitizeCv metía los idiomas dentro
   de skills y devolvía languages:[] a la fuerza, y ni el PDF ni el DOCX tenían
   sección de idiomas. Estos tests existen para que no vuelva a pasar. */

test('idiomas: sobreviven y salen en SU sección, no dentro de skills', () => {
  const cv = sanitizeCv({ ...dirty, skills: ['Python', 'SQL'], languages: ['Inglés - C2', 'Español (nativo)'] });
  assert.deepEqual(cv.languages, ['Inglés - C2', 'Español (nativo)']);
  assert.ok(!cv.skills.some((s) => /ingl|espa/i.test(s)), 'no se duplican en skills: ' + JSON.stringify(cv.skills));
  assert.ok(cv.skills.includes('Python') && cv.skills.includes('SQL'));
});

test('idiomas: se rescatan aunque el modelo los meta en skills', () => {
  const cv = sanitizeCv({ ...dirty, skills: ['Python', 'English (Native)', 'Excel'], languages: [] });
  assert.deepEqual(cv.languages, ['English (Native)']);
  assert.deepEqual(cv.skills, ['Python', 'Excel']);
});

test('idiomas: un CV con 30+ habilidades NO los pierde (el bug del recorte)', () => {
  /* Iban al final de skills y el slice(0,30) se los comía enteros: justo los
     CVs técnicos más cargados eran los que perdían el idioma. */
  const muchas = Array.from({ length: 35 }, (_, i) => `Skill${i}`);
  const cv = sanitizeCv({ ...dirty, skills: muchas, languages: ['Inglés - C2'] });
  assert.equal(cv.skills.length, 30);
  assert.deepEqual(cv.languages, ['Inglés - C2'], 'el idioma sobrevive al recorte de skills');
});

test('idiomas: un nombre de institución NO es un idioma', () => {
  const cv = sanitizeCv({ ...dirty, skills: [], languages: ['Hospital Francés', 'Instituto de Lengua Inglesa', 'Italiano (básico)'] });
  assert.deepEqual(cv.languages, ['Italiano (básico)']);
});

test('idiomas: una habilidad que MENCIONA un idioma sigue siendo habilidad', () => {
  const cv = sanitizeCv({ ...dirty, skills: ['Traducción inglés-español', 'Redacción técnica'], languages: [] });
  assert.equal(cv.languages.length, 0);
  assert.ok(cv.skills.includes('Traducción inglés-español'), JSON.stringify(cv.skills));
});

test('idiomas: sin idiomas declarados, la lista queda vacía (no se inventa nada)', () => {
  const cv = sanitizeCv({ ...dirty, skills: ['Python'], languages: [] });
  assert.deepEqual(cv.languages, []);
});

test('idiomas: el nivel se normaliza igual que en skills, sin inflarlo', () => {
  const cv = sanitizeCv({ ...dirty, skills: [], languages: ['Inglés (muy avanzado)', 'Italiano (muy poco)'] });
  assert.ok(cv.languages.includes('Inglés (avanzado)'), JSON.stringify(cv.languages));
  assert.ok(cv.languages.includes('Italiano (básico)'), JSON.stringify(cv.languages));
  assert.ok(!cv.languages.some((l) => /\b[ABC][12]\b/.test(l)), 'nunca un CEFR inventado');
});
