/**
 * test/ui/cvExtract.test.js
 *
 * La capa que convierte un PDF en texto y decide si ese texto tiene secciones.
 * Es la parte más frágil del producto: cambia la plantilla del CV de alguien y
 * se rompe todo lo de abajo. Estos tests existen para que NO se rompa en
 * silencio en la próxima refactorización.
 *
 * Se prueba contra la geometría real de pdf.js (items con transform y width),
 * no contra texto ya armado: es ahí donde vivía el bug del CV de dos columnas
 * que producía 502 determinísticos (23/07/2026).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boot } from './dom.js';

/** Un item como los que devuelve page.getTextContent() de pdf.js. */
const item = (str, x, y, w = str.length * 5, alto = 10) => ({
  str,
  width: w,
  transform: [alto, 0, 0, alto, x, y],
});

const { run } = boot({ profile: '' });
/** llama a la función real del producto dentro del contexto de la app */
const pageText = (items) => {
  run(`globalThis.__items = ${JSON.stringify(items)};`);
  return run('cvPageText(globalThis.__items)');
};
const tieneSecciones = (txt) => run(`cvTieneSecciones(${JSON.stringify(txt)})`);
const limpiar = (txt) => run(`cvCleanExtract(${JSON.stringify(txt)})`);

/* ── Orden de lectura ────────────────────────────────────────────────────── */

test('una sola columna: respeta el orden de arriba hacia abajo', () => {
  // pdf.js puede entregarlos desordenados; el orden lo da la geometría
  const out = pageText([
    item('Habilidades', 50, 500),
    item('Ana Ruiz', 50, 700),
    item('Experiencia laboral', 50, 600),
  ]);
  assert.equal(out, 'Ana Ruiz\nExperiencia laboral\nHabilidades');
});

test('los pedazos de un mismo renglón se unen en una línea', () => {
  const out = pageText([item('Gerente', 50, 700), item('de', 110, 700), item('Producto', 130, 700)]);
  assert.equal(out, 'Gerente de Producto');
});

test('dos columnas: NO se intercalan (el bug del 502 determinístico)', () => {
  /* Plantilla tipo Canva: perfil a la izquierda, experiencia a la derecha, a la
     misma altura. Unir por orden de archivo daba "Soy una Experiencia persona
     laboral..." — un rompecabezas que ni el parser ni el modelo podían leer. */
  const out = pageText([
    item('Soy una persona', 40, 600, 90),
    item('Experiencia laboral', 320, 600, 110),
    item('proactiva y', 40, 585, 90),
    item('Estudio Juridico Equality', 320, 585, 130),
    item('organizada.', 40, 570, 90),
    item('Atencion al publico.', 320, 570, 120),
    item('Contacto', 40, 540, 60),
    item('Municipalidad 2015', 320, 540, 110),
  ]);
  const lineas = out.split('\n');
  const iPerfil = lineas.findIndex((l) => l.includes('organizada'));
  const iExp = lineas.findIndex((l) => l.includes('Experiencia laboral'));
  assert.ok(iPerfil >= 0 && iExp >= 0, out);
  assert.ok(iPerfil < iExp, 'la columna izquierda va COMPLETA antes que la derecha:\n' + out);
  // y ninguna línea mezcla las dos columnas
  assert.ok(!lineas.some((l) => l.includes('Soy una persona') && l.includes('Experiencia')), out);
});

test('dos columnas: un título a lo ancho separa bandas', () => {
  /* El nombre cruza la página entera: lo que viene después pertenece a otro
     bloque y no puede quedar mezclado con lo de arriba. */
  const out = pageText([
    item('CARLA BLANCO — ABOGADA', 40, 750, 400),
    item('Perfil', 40, 700, 50),
    item('Experiencia', 320, 700, 80),
    item('Soy abogada.', 40, 685, 80),
    item('Estudio Equality', 320, 685, 90),
    item('Matriculada.', 40, 670, 80),
    item('Atencion al publico.', 320, 670, 110),
    item('Contacto', 40, 640, 60),
    item('Municipalidad', 320, 640, 90),
    item('11-5555-5555', 40, 625, 80),
    item('Eventos publicos.', 320, 625, 100),
  ]);
  const lineas = out.split('\n');
  assert.equal(lineas[0], 'CARLA BLANCO — ABOGADA', 'el encabezado va primero:\n' + out);
  assert.ok(lineas.indexOf('Soy abogada.') < lineas.indexOf('Estudio Equality'), out);
});

test('nunca devuelve vacío ni explota con entradas rotas', () => {
  // ante geometría inválida, texto licuado es mejor que romper la subida
  assert.equal(pageText([]), '');
  assert.equal(pageText([{ str: 'sin transform' }]), '');
  assert.equal(pageText([item('   ', 10, 10), item('Hola', 20, 10)]), 'Hola');
});

/* ── ¿El CV trae títulos de sección? ─────────────────────────────────────── */

test('reconoce las secciones en los 4 idiomas del producto', () => {
  assert.ok(tieneSecciones('Juan Perez\nExperiencia laboral\nAcme\nEducacion\nUBA\nHabilidades\nExcel'));
  assert.ok(tieneSecciones('John Doe\nWork Experience\nAcme\nEducation\nMIT\nSkills\nPython'));
  assert.ok(tieneSecciones('Jean Dupont\nExperience professionnelle\nFormation\nCompetences'));
  assert.ok(tieneSecciones('Joao Silva\nExperiencia profissional\nFormacao academica\nCompetencias'));
});

test('aguanta las variantes reales de los CV en castellano', () => {
  assert.ok(tieneSecciones('TRAYECTORIA PROFESIONAL\nAcme\nFORMACION ACADEMICA\nUBA'), 'sin tildes y en mayúsculas');
  assert.ok(tieneSecciones('Historial laboral\nAcme S.A. 2020-2024\nEstudios\nUniversidad de Buenos Aires'), 'sinónimos');
  assert.ok(tieneSecciones('Antecedentes laborales\nEstudio Perez 2019\nTitulacion\nAbogacia UNLP 2018'), 'más sinónimos');
});

test('dos de tres alcanza: hay CV legítimos sin sección de habilidades', () => {
  assert.ok(tieneSecciones('Ana\nExperiencia laboral\nAcme 2020-2024\nEducacion\nUBA 2015'));
});

test('dice que NO cuando de verdad no hay secciones', () => {
  assert.equal(tieneSecciones('Ana Ruiz\nana@mail.com\nTrabajé en Acme desde 2020.\nEstudié bastante.'), false);
  assert.equal(tieneSecciones('Hola, el sábado hacemos un asado. Llevá bebida.'), false);
  assert.equal(tieneSecciones(''), false);
  assert.equal(tieneSecciones(null), false);
});

/* ── Limpieza del texto extraído ─────────────────────────────────────────── */

test('cvCleanExtract: recompone tildes que pdf.js separa de la vocal', () => {
  assert.match(limpiar('San Andr´ es'), /San Andrés/);
  assert.match(limpiar('Ingenier´ ıa'), /Ingeniería/);
});

test('cvCleanExtract: une palabras cortadas por guion de renglón, sin tocar las legítimas', () => {
  assert.match(limpiar('com-\nmercial'), /commercial/);
  assert.match(limpiar('e-commerce y part-time'), /e-commerce y part-time/);
});

test('cvCleanExtract: saca la basura de las plantillas (PUA, ligaduras, invisibles)', () => {
  const sucio = ' Telefono: 11-5555 ﬁnanzas Ge­rente​ de Producto';
  const out = limpiar(sucio);
  assert.ok(!/[-]/.test(out), 'sin iconos de fuente privada: ' + out);
  assert.ok(out.includes('finanzas'), 'ligadura expandida: ' + out);
  assert.ok(out.includes('Gerente de Producto'), 'invisibles y NBSP: ' + out);
});

test('cvCleanExtract: re-pega versalitas partidas sin romper palabras de una letra', () => {
  const out = limpiar('G ERENTE DE P RODUCTO a cargo de A CARGO');
  assert.ok(out.includes('GERENTE DE PRODUCTO'), out);
  assert.ok(out.includes('A CARGO'), '"A CARGO" queda intacto: ' + out);
});
