import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(__dirname, '..', 'db');

const run = async () => {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    /* Un archivo con el banner de borrador NO se aplica. Antes el runner los corría
       igual (008/009 dicen "NO APLICAR TODAVÍA" y se aplicaban en cada deploy): el
       contrato del banner era falso, y una edición futura "total no corre" podía
       terminar en producción. Ahora el banner manda. */
    if (/NO APLICAR TODAV/i.test(sql)) { console.log(`→ ${f} ... saltada (borrador)`); continue; }
    process.stdout.write(`→ ${f} ... `);
    await pool.query(sql);
    console.log('ok');
  }
  await pool.end();
  console.log('Migraciones aplicadas.');
};

run().catch((e) => {
  console.error('Fallo la migración:', e.message);
  process.exit(1);
});
