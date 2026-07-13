/**
 * test/e2e/auth.spec.js — Playwright (navegador real).
 *
 *   npm i -D @playwright/test && npx playwright install chromium
 *   npx playwright test
 *
 * Los tests de test/ui/ cubren la lógica sin navegador (corren siempre, sin instalar nada).
 * Estos cubren lo que solo se puede verificar en un navegador de verdad: foco, scroll,
 * animaciones, visibilidad real de los campos.
 */
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('el formulario de registro se puede scrollear hasta el final (regresión del scroll-lock)', async ({ page }) => {
  await page.getByRole('button', { name: /iniciar sesión|sign in/i }).click();
  await page.getByRole('button', { name: /crear cuenta|create account/i }).click();

  const modal = page.locator('.modal.auth');
  await expect(modal).toBeVisible();

  // el confirmar-contraseña vive abajo de todo: tiene que ser alcanzable
  const confirm = page.locator('#auPass2');
  await confirm.scrollIntoViewIfNeeded();
  await expect(confirm).toBeInViewport();

  // y el fondo NO debe haberse movido
  const bodyOverflow = await page.evaluate(() => getComputedStyle(document.body).overflow);
  expect(bodyOverflow).toBe('hidden');
});

test('el ojo revela y vuelve a ocultar la contraseña', async ({ page }) => {
  await page.getByRole('button', { name: /iniciar sesión|sign in/i }).click();
  const input = page.locator('#auPass');
  await input.fill('Segura2026!');

  await expect(input).toHaveAttribute('type', 'password');
  await page.locator('#eye_auPass').click();
  await expect(input).toHaveAttribute('type', 'text');
  await page.locator('#eye_auPass').click();
  await expect(input).toHaveAttribute('type', 'password');
});

test('el botón de login no se bloquea al tipear la contraseña', async ({ page }) => {
  await page.getByRole('button', { name: /iniciar sesión|sign in/i }).click();
  await page.locator('#auEmail').fill('fede@mail.com');
  await page.locator('#auPass').fill('miclave');
  await expect(page.locator('#auGo')).toBeEnabled();
});

test('el cambio entre login y registro es fluido y no se traba', async ({ page }) => {
  await page.getByRole('button', { name: /iniciar sesión|sign in/i }).click();
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: /crear cuenta|create account/i }).click();
    await expect(page.locator('#auPass2')).toBeVisible();
    await page.getByRole('button', { name: /iniciar sesión|sign in/i }).nth(1).click();
    await expect(page.locator('#auPass2')).toHaveCount(0);
  }
});

test('las 5 reglas de contraseña se marcan en verde y habilitan el botón', async ({ page }) => {
  await page.getByRole('button', { name: /iniciar sesión|sign in/i }).click();
  await page.getByRole('button', { name: /crear cuenta|create account/i }).click();

  await page.locator('#auName').fill('Federico');
  await page.locator('#auEmail').fill('fede@mail.com');
  await page.locator('#auPass').fill('debil');
  await expect(page.locator('#auGo')).toBeDisabled();

  await page.locator('#auPass').fill('Segura2026!');
  await page.locator('#auPass2').fill('Segura2026!');
  await expect(page.locator('.pw-rule.ok')).toHaveCount(5);
  await expect(page.locator('#auGo')).toBeEnabled();
});
