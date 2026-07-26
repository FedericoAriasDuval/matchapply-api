/**
 * test/contact.test.js
 * Las notificaciones de contacto y reseña NO deben depender de un SMTP para no
 * romper nada: sin transporter (dev/test) hacen no-op, y el aviso de reseña
 * tolera datos raros sin tirar (porque se dispara sin await para no tumbar el
 * guardado de la reseña en la base).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/* mailer.js importa config.js, que EXIGE estas envs al cargar. Se setean ANTES del
   import (dinámico, porque los import estáticos se hoistean y correrían primero).
   Sin SMTP configurado, el mailer entra en modo dev y no envía nada. */
process.env.DATABASE_URL ??= 'postgres://nadie:nadie@127.0.0.1:1/nada';
process.env.JWT_SECRET ??= 'solo-para-tests';
const { sendContactEmail, sendReviewNotification } = await import('../src/lib/mailer.js');

test('contacto sin SMTP: no envía, no falla (modo dev)', async () => {
  const r = await sendContactEmail({ name: 'Ana', email: 'ana@x.com', message: 'hola', lang: 'es' });
  assert.equal(r.dev, true);
  assert.equal(r.delivered, false);
});

test('aviso de reseña sin SMTP: no envía, no falla (modo dev)', async () => {
  const r = await sendReviewNotification({ stars: 5, comment: 'genial', lang: 'en' });
  assert.equal(r.dev, true);
});

test('aviso de reseña: tolera datos raros sin romper (protege el guardado)', async () => {
  await assert.doesNotReject(sendReviewNotification({ stars: 99 }));
  await assert.doesNotReject(sendReviewNotification({}));
  await assert.doesNotReject(sendReviewNotification({ stars: 0, comment: '', name: '', page: '' }));
});
