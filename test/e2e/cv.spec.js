/**
 * test/e2e/cv.spec.js — flujos de CV y paywall en navegador real.
 */
import { expect, test } from '@playwright/test';

const CV = `Federico Arias Duval
fede@mail.com | +54 11 4444-2222

EXPERIENCIA
Analista de Datos — Globant | 2022 - Actualidad
- Automaticé los reportes mensuales y ahorré 6 horas por semana.

EDUCACIÓN
Universidad de Buenos Aires — Licenciatura en Sistemas | 2018 - 2023

HABILIDADES
Python, SQL, Power BI`;

test('el diagnóstico cita logros reales del CV cargado', async ({ page }) => {
  await page.goto('/#herramientas/diagnostico');
  await page.locator('#profile').fill(CV);
  await expect(page.locator('.sw-box.str li')).not.toHaveCount(0);
  await expect(page.locator('.au-meter')).toContainText(/1|2/);
});

test('el usuario free ve la hoja de CV en solo lectura y el candado Pro', async ({ page }) => {
  await page.goto('/#herramientas/diagnostico');
  await page.locator('#profile').fill(CV);
  await expect(page.locator('.cv-doc')).toHaveClass(/locked/);
  await expect(page.locator('#cvEditBtn')).toContainText(/PRO/i);
});

test('el paywall se abre con la vitrina de beneficios y no como un muro', async ({ page }) => {
  await page.goto('/#herramientas/diagnostico');
  await page.locator('#profile').fill(CV);
  await page.locator('#cvEditBtn').click();
  await expect(page.locator('.modal.pro')).toBeVisible();
  await expect(page.locator('.pro-list li')).toHaveCount(5);
  await expect(page.locator('.pro-cta')).toBeVisible();
});

test('el progreso se recupera tras recargar la página', async ({ page }) => {
  await page.goto('/#herramientas');
  await page.locator('#profile').fill(CV);
  await page.waitForTimeout(800);            // debounce del autoguardado
  await page.reload();
  await expect(page.locator('#profile')).toHaveValue(/Federico Arias Duval/);
  await expect(page.locator('.toast')).toContainText(/Recuperamos tu progreso/i);
});
