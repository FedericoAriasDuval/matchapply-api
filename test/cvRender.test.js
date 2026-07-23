/**
 * test/cvRender.test.js
 *
 * El PDF/DOCX que la persona MANDA A UNA EMPRESA. Dos cosas se verifican acá,
 * y las dos son promesas del producto:
 *   1. La sección de IDIOMAS existe. Se perdía entera (23/07/2026).
 *   2. Los títulos de sección salen ENTEROS al extraer el texto. Con el
 *      espaciado entre letras que teníamos, un extractor leía "EDU CAC IÓN" y
 *      "HABI LIDA DES": el CV que generamos tenía justo el defecto que este
 *      producto existe para detectar.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderCvPdf } from '../src/lib/pdf.js';
import { renderCvDocx } from '../src/lib/docx.js';

const CV = {
  name: 'Santino Domato',
  contact: { email: 's@mail.com', phone: '+54 9 3436 41-5829', linkedin: '', github: '', website: '', location: 'Tigre' },
  summary: 'Estudiante de Ingenieria en IA.',
  summary_is_generated: false,
  experience: [{ role: 'Junior Pricing Analyst', company: 'Kavak', location: 'BA', start: '10/2025', end: 'present', bullets: ['Extraccion de datos con SQL'] }],
  education: [{ institution: 'Universidad de San Andres', degree: 'Ing. en IA', location: '', start: '2023', end: 'present' }],
  skills: ['Python', 'SQL', 'PyTorch'],
  languages: ['Ingles - C2', 'Espanol (nativo)'],
  interests: ['Ciclismo'],
  warnings: [],
};

/**
 * El texto del PDF tal como lo reconstruye un extractor.
 *
 * En el flujo, cada línea es `[<hex> kern <hex> ...] TJ`: los trozos hexa se
 * concatenan y los números del medio son ajustes finos de kerning (un extractor
 * no los convierte en espacios). Decodificar esto es exactamente lo que hacen
 * pdf.js y los parsers de un ATS.
 */
const textoDelPdf = async (cv, lang) => {
  const crudo = (await renderCvPdf(cv, lang, { compress: false })).toString('latin1');
  const lineas = [...crudo.matchAll(/\[(.*?)\]\s*TJ/g)].map(([, cuerpo]) =>
    [...cuerpo.matchAll(/<([0-9a-fA-F]+)>/g)]
      .map(([, hex]) => Buffer.from(hex, 'hex').toString('latin1'))
      .join(''),
  );
  return lineas.join('\n');
};

/** El espaciado entre letras que se aplica a los títulos (operador Tc). */
const espaciadosDeTitulo = async (lang) => {
  const crudo = (await renderCvPdf(CV, lang, { compress: false })).toString('latin1');
  return [...crudo.matchAll(/([\d.]+)\s+Tc/g)].map(([, v]) => Number(v));
};

/* Sin acentos: en el flujo los acentos viajan con la codificación de la fuente,
   y lo que se está verificando acá es que la PALABRA no venga partida. */
const TITULOS = {
  es: ['RESUMEN PROFESIONAL', 'EXPERIENCIA', 'HABILIDADES', 'IDIOMAS', 'INTERESES'],
  en: ['PROFESSIONAL SUMMARY', 'EXPERIENCE', 'EDUCATION', 'SKILLS', 'LANGUAGES', 'INTERESTS'],
  fr: ['PROFIL PROFESSIONNEL', 'EXP', 'LANGUES'],
  pt: ['RESUMO PROFISSIONAL', 'IDIOMAS'],
};

/* OJO CON LO QUE ESTE TEST NO PRUEBA (comprobado volviendo el valor viejo):
   el texto viaja entero en el flujo AUNQUE el espaciado sea alto — el título se
   parte recién cuando el extractor lo lee. O sea que estos cuatro tests NO
   atrapan el bug de "EDU CAC IÓN"; el que lo atrapa es el del espaciado, abajo.
   Estos garantizan lo otro: que el título exista, esté completo y en su idioma. */
for (const [lang, titulos] of Object.entries(TITULOS)) {
  test(`PDF ${lang}: cada sección tiene su título, completo y traducido`, async () => {
    const texto = await textoDelPdf(CV, lang);
    for (const titulo of titulos) {
      assert.ok(texto.includes(titulo), `"${titulo}" sale partido o falta en el PDF ${lang}:\n${texto}`);
    }
  });
}

test('PDF: el espaciado entre letras de los títulos se mantiene bajo', async () => {
  /* Es LA causa del bug: con Tc alto el extractor mete un espacio entre glifos
     y el título deja de existir para un filtro automático. */
  const tcs = await espaciadosDeTitulo('es');
  assert.ok(tcs.length > 0, 'no se encontró ningún Tc: cambió el renderizador');
  for (const tc of tcs) assert.ok(tc <= 0.6, `espaciado ${tc} demasiado alto: parte los títulos`);
});

test('PDF: la sección de IDIOMAS existe y trae los idiomas', async () => {
  const texto = await textoDelPdf(CV, 'es');
  assert.ok(texto.includes('IDIOMAS'), 'falta el título de la sección:\n' + texto);
  assert.ok(texto.includes('Ingles - C2'), 'falta el idioma con su nivel:\n' + texto);
});

test('PDF: sin idiomas declarados, no se dibuja una sección vacía', async () => {
  const texto = await textoDelPdf({ ...CV, languages: [] }, 'es');
  assert.ok(!texto.includes('IDIOMAS'), 'no debe aparecer el título sin contenido');
  assert.ok(texto.includes('HABILIDADES'), 'el resto del CV sigue igual');
});

test('PDF: se genera en los 4 idiomas sin romperse', async () => {
  for (const lang of ['es', 'en', 'fr', 'pt']) {
    const pdf = await renderCvPdf(CV, lang);
    assert.ok(Buffer.isBuffer(pdf) && pdf.length > 1000, `PDF ${lang} vacío o roto`);
    assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  }
});

test('DOCX: se genera y crece cuando hay idiomas (la sección se escribe)', async () => {
  const con = await renderCvDocx(CV, 'es');
  const sin = await renderCvDocx({ ...CV, languages: [] }, 'es');
  assert.ok(Buffer.isBuffer(con) && con.length > 2000);
  assert.ok(con.length > sin.length, 'el DOCX con idiomas tiene que traer más contenido');
});

test('los renderizadores aguantan un CV incompleto sin explotar', async () => {
  /* Un CV al que la IA no le pudo sacar casi nada NO puede tirar la descarga:
     la persona tiene que poder bajarse lo que haya. */
  const minimo = { name: 'Ana', contact: {}, summary: '', experience: [], education: [], skills: [], languages: [], interests: [], warnings: [] };
  const pdf = await renderCvPdf(minimo, 'es');
  const docx = await renderCvDocx(minimo, 'es');
  assert.ok(pdf.length > 500 && docx.length > 1000);
});
