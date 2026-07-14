#!/usr/bin/env node
/**
 * scripts/feedback.js
 * "¿Que estamos haciendo bien y que hay que arreglar?" — en una sola linea de terminal.
 *
 *     node scripts/feedback.js            # ultimos 30 dias
 *     node scripts/feedback.js 7          # ultima semana
 *
 * No construi un panel de admin, y es a proposito: un panel es una pantalla que
 * mirás dos veces y despues nunca mas. Un comando que te escupe el resumen en la
 * terminal, en cambio, lo corres antes de cada sprint. La herramienta correcta
 * para dos fundadores no es un dashboard: es un comando.
 */
import { query, pool } from '../src/db.js';
import { completeJson } from '../src/lib/llm.js';

const days = Number(process.argv[2] ?? 30);

const bar = (n, total, width = 22) => {
  const full = total ? Math.round((n / total) * width) : 0;
  return '█'.repeat(full) + '░'.repeat(width - full);
};

const main = async () => {
  const { rows: st } = await query(
    `select count(*)::int total,
            round(avg(stars)::numeric,2) promedio,
            count(*) filter (where stars>=4)::int promotores,
            count(*) filter (where stars=3)::int  neutros,
            count(*) filter (where stars<=2)::int detractores
       from reviews where created_at > now() - ($1 || ' days')::interval`,
    [days],
  );
  const s = st[0];

  console.log('\n──────────────────────────────────────────────────────────');
  console.log(`  MatchApply · Satisfaccion · ultimos ${days} dias`);
  console.log('──────────────────────────────────────────────────────────\n');

  if (!s.total) {
    console.log('  Todavia no hay ni una resena.\n');
    console.log('  Eso no es un problema de producto: es que nadie las esta pidiendo.');
    console.log('  Pedila en el momento del "CV impecable", que es el unico donde');
    console.log('  la persona siente orgullo.\n');
    await pool.end();
    return;
  }

  const nps = Math.round(((s.promotores - s.detractores) / s.total) * 100);

  console.log(`  Resenas:   ${s.total}`);
  console.log(`  Promedio:  ${s.promedio} / 5`);
  console.log(`  NPS:       ${nps > 0 ? '+' : ''}${nps}${s.total < 10 ? '   ⚠ con menos de 10 respuestas, este numero no significa nada' : ''}`);
  console.log('');
  console.log(`  Promotores  (4-5) ${bar(s.promotores, s.total)}  ${s.promotores}`);
  console.log(`  Neutros     (3)   ${bar(s.neutros, s.total)}  ${s.neutros}`);
  console.log(`  Detractores (1-2) ${bar(s.detractores, s.total)}  ${s.detractores}`);
  console.log('');

  const { rows: cs } = await query(
    `select stars, comment from reviews
      where comment is not null and created_at > now() - ($1 || ' days')::interval
      order by created_at desc limit 200`,
    [days],
  );

  if (!cs.length) {
    console.log('  Hay puntajes pero ningun comentario. El numero solo no te dice que tocar.\n');
    await pool.end();
    return;
  }

  const texto = cs.map((c) => `[${c.stars}/5] ${String(c.comment).replace(/\s+/g, ' ').slice(0, 400)}`).join('\n');

  const r = await completeJson({
    system:
      'Sos analista de producto. Recibis resenas reales de una plataforma de empleabilidad. ' +
      'Devolves JSON: {"funciona_bien":[{"tema":string,"evidencia":string,"menciones":number}],' +
      '"hay_que_arreglar":[{"tema":string,"evidencia":string,"menciones":number,"urgencia":"alta"|"media"|"baja"}],' +
      '"cita_destacada":string,"veredicto":string}. ' +
      'Agrupa por TEMA. La evidencia es una cita textual corta. No inventes temas. Si algo se ' +
      'menciona una sola vez, decilo. Se directo: esto lo leen los fundadores para decidir que ' +
      'tocar manana, no para sentirse bien.',
    user: `Resenas (${cs.length}):\n\n${texto}`,
    maxTokens: 1500,
    fallback: () => null,
  });

  if (!r) {
    console.log('  La IA no esta disponible. Los comentarios crudos:\n');
    cs.forEach((c) => console.log(`  [${c.stars}/5] ${c.comment}`));
    console.log('');
    await pool.end();
    return;
  }

  console.log('  LO QUE ESTAMOS HACIENDO BIEN');
  (r.funciona_bien || []).forEach((x) =>
    console.log(`   ✓ ${x.tema}  (${x.menciones})\n     "${x.evidencia}"`),
  );
  console.log('\n  LO QUE HAY QUE ARREGLAR');
  (r.hay_que_arreglar || [])
    .sort((a, b) => ({ alta: 0, media: 1, baja: 2 }[a.urgencia] - { alta: 0, media: 1, baja: 2 }[b.urgencia]))
    .forEach((x) =>
      console.log(`   ${x.urgencia === 'alta' ? '!' : '·'} [${x.urgencia}] ${x.tema}  (${x.menciones})\n     "${x.evidencia}"`),
    );

  if (r.cita_destacada) console.log(`\n  LA CITA:\n   "${r.cita_destacada}"`);
  if (r.veredicto) console.log(`\n  VEREDICTO:\n   ${r.veredicto}`);
  console.log('\n──────────────────────────────────────────────────────────\n');

  await pool.end();
};

main().catch(async (e) => {
  console.error('Fallo el resumen:', e.message);
  await pool.end();
  process.exit(1);
});
