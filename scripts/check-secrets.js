#!/usr/bin/env node
/* =====================================================================
   check-secrets — se corre ANTES de cada push. `npm run check:secrets`
 
   Existe porque un secreto que llega a un commit publico no se borra:
   queda en el historial para siempre y hay que ROTARLO. Diez segundos
   aca valen mas que una hora de panico despues.
 
   Dos controles, y son distintos a proposito:
 
     1. NINGUN archivo (salvo .env.example) puede contener algo con forma
        de credencial.
     2. .env.example no puede tener NINGUN valor asignado. Es la lista de
        nombres, no de valores. Si alguien escribe el suyo ahi "por un
        rato", esto lo frena.
   ===================================================================== */
import fs from 'node:fs';
import path from 'node:path';

const SKIP = new Set(['node_modules', '.git', 'uploads', 'coverage', 'dist', 'build',
                      'test-results', 'playwright-report', '.playwright']);

const PATRONES = [
  ['API key de Anthropic', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['API key de Resend',    /\bre_[A-Za-z0-9_-]{20,}/],
  ['Clave secreta Stripe', /\bsk_(?:live|test)_[A-Za-z0-9]{20,}/],
  ['Webhook de Stripe',    /\bwhsec_[A-Za-z0-9]{20,}/],
  ['Credencial de AWS',    /\bAKIA[0-9A-Z]{16}\b/],
  ['Clave privada',        /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  // Una URL de Postgres con password real. La local de docker-compose
  // (mavante:mavante@db) queda fuera: es de juguete y no da acceso a nada.
  ['Cadena de Postgres',   /postgres(?:ql)?:\/\/(?!mavante:mavante@db)[^\s'"]+:[^\s'"@]+@[^\s'"]+\.[a-z]{2,}/i],
];

let fallas = 0, revisados = 0;

const caminar = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) caminar(p); continue; }
    // Un .env de verdad no deberia existir; si existe, .gitignore lo tapa.
    if (e.name === '.env' || (e.name.startsWith('.env.') && e.name !== '.env.example')) continue;
    // .env.example esta lleno de placeholders a proposito: se revisa aparte.
    if (e.name === '.env.example') continue;

    let txt;
    try { txt = fs.readFileSync(p, 'utf8'); } catch { continue; }
    revisados++;
    for (const [nombre, re] of PATRONES) {
      const m = txt.match(re);
      if (m) {
        const linea = txt.slice(0, m.index).split('\n').length;
        console.error(`  🔴 ${p}:${linea} — ${nombre}`);
        fallas++;
      }
    }
  }
};

console.log('Buscando secretos…');
caminar('.');
console.log(`  ${revisados} archivos revisados`);

// --- control 2: .env.example tiene que estar VACIO de valores ---
if (fs.existsSync('.env.example')) {
  const lineas = fs.readFileSync('.env.example', 'utf8').split('\n');
  lineas.forEach((ln, i) => {
    const m = /^([A-Z_0-9]+)=(.+)$/.exec(ln.trim());
    if (!m) return;
    const valor = m[2].trim();
    // Los valores no sensibles (puertos, flags, modelo) pueden estar: son config, no secreto.
    const OK = ['NODE_ENV', 'PORT', 'APP_URL', 'PGSSL', 'ACCESS_TTL', 'REFRESH_TTL_DAYS',
                'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'MAIL_FROM', 'LLM_MODEL',
                'LLM_TIMEOUT_MS', 'LLM_BREAKER_THRESHOLD', 'LLM_BREAKER_COOLDOWN_MS',
                'CV_CONCURRENCY', 'CV_MAX_QUEUE', 'CV_TIMEOUT_MS', 'COOKIE_DOMAIN'];
    if (OK.includes(m[1])) return;
    console.error(`  🔴 .env.example:${i + 1} — ${m[1]} tiene un valor. Este archivo lleva nombres, no valores.`);
    fallas++;
  });
}

if (fallas) {
  console.error(`\n❌ ${fallas} problema(s). NO hagas push hasta resolverlos.`);
  process.exit(1);
}
console.log('\n✅ Limpio. Se puede subir a GitHub.');
