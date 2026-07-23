/**
 * test/ui/interviewSignals.test.js
 *
 * La sala de práctica GRATIS evalúa la respuesta escrita con TRES señales
 * (número / cliché / cierre), sin IA, en el navegador. Y al lado muestra la
 * respuesta que NOSOTROS preparamos como ejemplo.
 *
 * El bug (23/07/2026, reportado por Federico): copiaba y pegaba LITERAL nuestra
 * propia respuesta modelo y el checker le clavaba una cruz roja en "no hay ni un
 * número" — porque el número estaba escrito con letras ("dos veces", "twice",
 * "deux fois", "duas vezes") y el detector solo veía dígitos. Incoherente:
 * presentamos una respuesta como la ideal y nuestro propio chequeo la reprueba.
 *
 * Regla que estos tests hacen cumplir: NUESTRAS RESPUESTAS PREPARADAS PASAN
 * NUESTRO PROPIO CHEQUEO — las tres señales en verde, en los cuatro idiomas.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boot } from './dom.js';

const { run } = boot({ profile: '' });
const check = (lang, key) =>
  JSON.parse(run(`lang=${JSON.stringify(lang)}; JSON.stringify(diCheck(t(${JSON.stringify(key)})))`));
const goodKeys = () => JSON.parse(run('JSON.stringify(Object.keys(DEMO_INT).map(function(r){return DEMO_INT[r].good;}))'));

for (const lang of ['es', 'en', 'fr', 'pt']) {
  test(`respuestas preparadas: las 3 señales en verde (${lang})`, () => {
    for (const key of goodKeys()) {
      const c = check(lang, key);
      assert.ok(c.num, `[${lang}/${key}] "número" en rojo: el detector no vio el número`);
      assert.ok(!c.cliche, `[${lang}/${key}] marcó un cliché inexistente: "${c.cliche}"`);
      assert.ok(c.cierra, `[${lang}/${key}] "cierre" en rojo`);
    }
  });
}

test('número: cuenta los escritos con letras (dos veces, twice, deux, duas)', () => {
  assert.ok(check('es', '_')?.num === undefined || true); // no-op para dejar claro el uso de run abajo
  const num = (lang, txt) => run(`lang=${JSON.stringify(lang)}; String(diCheck(${JSON.stringify(txt)}).num)`) === 'true';
  assert.ok(num('es', 'Reescribí el módulo dos veces hasta que quedó aprobado por todo el equipo sin cambios'));
  assert.ok(num('en', 'I rewrote the whole module twice before the team approved it without a single change'));
  assert.ok(num('fr', "J'ai réécrit le module deux fois avant que l'équipe le valide sans aucune reprise"));
  assert.ok(num('pt', 'Reescrevi o módulo inteiro duas vezes até o time aprovar sem nenhuma mudança'));
});

test('número: NO cuenta los artículos "un/una/one/une" (si no, pasa cualquier frase)', () => {
  const num = (lang, txt) => run(`lang=${JSON.stringify(lang)}; String(diCheck(${JSON.stringify(txt)}).num)`) === 'true';
  assert.ok(!num('es', 'Trabajé en un equipo con una empresa grande durante mucho tiempo haciendo tareas variadas'));
  assert.ok(!num('en', 'I worked with a great team at a large company for a long time doing all sorts of things'));
  assert.ok(!num('fr', "J'ai travaillé avec une équipe formidable pendant longtemps sur des projets variés"));
});

test('número: una respuesta de puros adjetivos sigue en rojo', () => {
  const c = JSON.parse(run(`lang="es"; JSON.stringify(diCheck('Soy una persona muy dedicada, comprometida y responsable, siempre doy lo mejor de mí en el equipo'))`));
  assert.equal(c.num, false);
});
