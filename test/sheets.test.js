/**
 * test/sheets.test.js
 * La sincronización a Google Sheets NO puede depender de estar configurada para no
 * romper nada: sin credenciales (config.sheets.enabled=false) todo es no-op, y los
 * appends NUNCA lanzan — porque se disparan fire-and-forget desde rutas y webhooks
 * de pago, donde un throw tumbaría el flujo del usuario o la confirmación del cobro.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/* config.js exige estas envs al cargar; NO seteamos GOOGLE_SA_* → sheets apagado. */
process.env.DATABASE_URL ??= 'postgres://nadie:nadie@127.0.0.1:1/nada';
process.env.JWT_SECRET ??= 'solo-para-tests';
const { appendReviewRow, appendContactRow, appendIncomeRow, sheetsEnabled } = await import('../src/lib/sheets.js');

test('sin credenciales: Sheets está apagado y los appends son no-op', async () => {
  assert.equal(sheetsEnabled(), false);
  assert.deepEqual(await appendReviewRow({ stars: 5, comment: 'x' }), { skipped: true });
  assert.deepEqual(await appendContactRow({ email: 'a@b.com', message: 'x' }), { skipped: true });
  assert.deepEqual(await appendIncomeRow({ txnId: 't1', gross: 10 }), { skipped: true });
});

test('los appends NUNCA lanzan, ni con datos ausentes o raros', async () => {
  await assert.doesNotReject(appendReviewRow({}));
  await assert.doesNotReject(appendContactRow({}));
  await assert.doesNotReject(appendIncomeRow({}));
  await assert.doesNotReject(appendIncomeRow({ gross: null, fee: undefined, net: '' }));
});
