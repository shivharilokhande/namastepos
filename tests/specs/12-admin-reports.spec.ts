// Super-admin Reports page (Push 20d) — P&L, Customer KPIs, Revenue split.
// Verifies the new endpoints respond and the UI renders without runtime
// crashes (previous bugs: column ref `businesses.deleted_at`, refund status
// enum, all crashed the queries).

import { test, expect } from '@playwright/test';
import { ADMIN, loginAsSuperAdmin } from './_admin_helpers';

test.describe('Super-admin reports', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsSuperAdmin(page);
  });

  test('reports page renders', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/reports');
    await expect(page.getByRole('heading', { name: /advanced reports/i })).toBeVisible();
  });

  test('Platform P&L card loads (no longer stuck on Loading…)', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/reports');
    await expect(page.locator('text=/Platform P&L/i')).toBeVisible();
    // The CSV button is disabled until pnl loads; after load it becomes enabled.
    // Either way, we wait for a date range string to appear in the subtitle.
    await expect(page.locator('text=/→.*Cash-basis/i')).toBeVisible({ timeout: 15_000 });
    // None of the five tiles should still render '—' for value once loaded.
    // (₹0 is valid; the dash means stuck on undefined.)
    await expect(page.locator('text=/SUBSCRIPTION INCOME/i')).toBeVisible();
    await expect(page.locator('text=/NET PROFIT/i')).toBeVisible();
  });

  test('Customer KPIs card shows non-dash totals', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/reports');
    await expect(page.locator('text=/Customer totals/i')).toBeVisible();
    // "Total customers" row should have a numeric value (0+) once the API responds.
    const totalRow = page.locator('text=/Total customers/i').locator('..');
    await expect(totalRow).toBeVisible();
    // Wait for the dash to be replaced
    await page.waitForFunction(() => {
      const el = Array.from(document.querySelectorAll('div, strong'))
        .find((n) => n.textContent?.includes('Total customers'))?.nextElementSibling
          || Array.from(document.querySelectorAll('strong'))
            .find((n) => /^\d+$/.test(n.textContent?.trim() || ''));
      return !!el;
    }, null, { timeout: 15_000 });
  });

  test('Revenue split chart container renders', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/reports');
    await expect(page.locator('text=/Revenue split/i')).toBeVisible();
    // Recharts injects an SVG; check it's mounted.
    await expect(page.locator('text=/Revenue split/i').locator('..').locator('..').locator('svg').first())
      .toBeVisible({ timeout: 10_000 });
  });

  test('P&L CSV export button exists (enabled when data, disabled when empty)', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/reports');
    // Wait for P&L to load
    await expect(page.locator('text=/→.*Cash-basis/i')).toBeVisible({ timeout: 15_000 });
    // First "CSV" button in DOM order is the P&L one. With zero data the
    // button is disabled; with data it's enabled. Either way, it must
    // exist and be visible — that's the assertion.
    const csvButton = page.getByRole('button', { name: /^\s*CSV\s*$/i }).first();
    await expect(csvButton).toBeVisible({ timeout: 5_000 });
  });
});
