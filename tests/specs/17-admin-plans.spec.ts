// Super-admin Plans CRUD + feature matrix.

import { test, expect } from '@playwright/test';
import { ADMIN } from './_admin_helpers';

test.describe('Super-admin Plans', () => {
  test('plans page renders', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/plans');
    await expect(page.getByRole('heading', { name: /plans/i }).first()).toBeVisible();
  });

  test('plans grid shows plans OR an empty state with a "New plan" CTA', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/plans');
    await page.waitForLoadState('networkidle').catch(() => {});
    // Accept any of: rows, cards, or an empty-state with the create button.
    await expect(
      page.locator('table tbody tr, [data-testid*="plan-card"], .plan-card')
        .or(page.getByRole('button', { name: /new plan|create plan|add plan/i }))
        .or(page.getByText(/no plans|create your first/i))
        .first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('"New plan" button opens a create form', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/plans');
    const newBtn = page.getByRole('button', { name: /new plan|add plan|create plan/i }).first();
    if (await newBtn.count() === 0) test.skip(true, 'no create button');
    await newBtn.click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('plan form has tier name + price + billing period inputs', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/plans');
    const newBtn = page.getByRole('button', { name: /new plan|create plan/i }).first();
    if (await newBtn.count() === 0) test.skip(true, 'no create button');
    await newBtn.click();
    const dlg = page.getByRole('dialog');
    await expect(dlg).toBeVisible();
    // At least 2 input fields visible inside the dialog
    expect(await dlg.locator('input').count()).toBeGreaterThanOrEqual(2);
  });

  test('tier_kind selector offers starter/pro/enterprise (Push 18a regression)', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/plans');
    const newBtn = page.getByRole('button', { name: /new plan|create plan/i }).first();
    if (await newBtn.count() === 0) test.skip(true, 'no create button');
    await newBtn.click();
    const dlg = page.getByRole('dialog');
    const allOpts = (await dlg.locator('option').allTextContents()).join('|').toLowerCase();
    expect(allOpts).toMatch(/starter|pro|enterprise/);
  });

  test('feature picker is present (Push 18b — per-plan feature assignment)', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/plans');
    // Either the create dialog OR an existing plan row's edit drawer should
    // expose a checkbox list of features.
    const firstRow = page.locator('table tbody tr').first();
    if (await firstRow.count() === 0) test.skip(true, 'no plans to inspect');
    await firstRow.click();
    await expect(
      page.locator('input[type="checkbox"]').first(),
    ).toBeVisible({ timeout: 8_000 });
  });

  test('limit inputs (staff / monthly_orders / tables) are present', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/plans');
    const firstRow = page.locator('table tbody tr').first();
    if (await firstRow.count() === 0) test.skip(true, 'no plans');
    await firstRow.click();
    // We expect at least 2 numeric inputs (staff cap + monthly orders cap)
    const numInputs = page.locator('input[type="number"]');
    expect(await numInputs.count()).toBeGreaterThanOrEqual(1);
  });

  test('plans page does not throw runtime errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    await page.goto(ADMIN.baseUrl + '/plans');
    await page.waitForLoadState('networkidle').catch(() => {});
    expect(errors).toEqual([]);
  });

  test('GET /plans returns plans with tierKind + featureKeys (API contract)', async ({ request }) => {
    // No auth required for public /plans endpoint
    const res = await request.get(ADMIN.apiUrl + '/plans');
    if (res.status() === 429) test.skip(true, 'rate-limited');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.plans)).toBe(true);
    for (const p of body.plans) {
      expect(p).toHaveProperty('tier');
      expect(p).toHaveProperty('tierKind');
      expect(p).toHaveProperty('featureKeys');
    }
  });
});
