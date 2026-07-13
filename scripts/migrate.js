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
