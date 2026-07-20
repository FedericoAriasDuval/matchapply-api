/**
 * scripts/company.js
 * Da de alta una empresa en el Panel de Talento y le imprime su clave UNA vez.
 *
 * POR QUÉ ES UN SCRIPT Y NO UN FORMULARIO DE REGISTRO:
 * cada empresa que entra acá mira perfiles de personas reales. Un auto-registro
 * significa que cualquiera con un mail se pone a mirar. La puerta la abre una
 * persona, mira quién es, y recién ahí entrega la clave.
 *
 *   node scripts/company.js "Nubetech SA" fintech "11-50" hola@nubetech.com
 *
 * La clave se muestra UNA sola vez: en la base vive hasheada. Si se pierde, se
 * da de baja esa empresa y se genera otra.
 */
import crypto from 'node:crypto';
import { query, pool } from '../src/db.js';
import { hashApiKey } from '../src/routes/corporate.js';

const [nombre, sector, tamano, email] = process.argv.slice(2);

if (!nombre || !email) {
  console.error('Uso: node scripts/company.js "<nombre>" <sector> "<tamaño>" <email>');
  console.error('Ej.: node scripts/company.js "Nubetech SA" fintech "11-50" hola@nubetech.com');
  process.exit(1);
}

/* 32 bytes de aleatoriedad criptográfica. El prefijo `mv_co_` no es decoración:
   sirve para reconocerla de un vistazo si aparece pegada donde no debe, y para
   que un escáner de secretos la detecte antes de que se filtre en un repo. */
const clave = `mv_co_${crypto.randomBytes(32).toString('base64url')}`;

try {
  const { rows } = await query(
    `insert into companies (name, sector, size_label, contact_email, api_key_hash)
     values ($1, $2, $3, $4, $5)
     returning id, name, created_at`,
    [nombre, sector ?? null, tamano ?? null, email, hashApiKey(clave)],
  );

  console.log('\n✅ Empresa creada');
  console.log('   id     :', rows[0].id);
  console.log('   nombre :', rows[0].name);
  console.log('\n🔑 CLAVE DE ACCESO (se muestra UNA sola vez):\n');
  console.log('   ' + clave + '\n');
  console.log('   Se usa así:  Authorization: Bearer ' + clave.slice(0, 12) + '…');
  console.log('   Guardala en un gestor de contraseñas y pasásela por un canal seguro.');
  console.log('   NO la mandes por chat ni la pegues en un ticket.\n');
} catch (e) {
  console.error('No se pudo crear la empresa:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
