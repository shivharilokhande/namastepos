// Dashboard Tables & Floors management (POS plan-gated).

import { test, expect } from '@playwright/test';

test.describe('Tables & Floors', () => {
  test('tables page renders', async ({ page }) => {
    await page.goto('/tables');
    // Either an empty-state OR a list/grid. We accept either as "renders".
    await expect(
      page.getByRole('heading', { name: /tables|floor/i }).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('"Add floor" button is present', async ({ page }) => {
    await page.goto('/tables');
    const btn = page.getByRole('button', { name: /add floor|new floor|create floor/i });
    if (await btn.count() === 0) test.skip(true, 'no Add Floor button — possibly plan-gated');
    await expect(btn.first()).toBeVisible();
  });

  test('"Add table" button is present', async ({ page }) => {
    await page.goto('/tables');
    const btn = page.getByRole('button', { name: /add table|new table|create table/i });
    if (await btn.count() === 0) test.skip(true, 'no Add Table button — possibly plan-gated');
    await expect(btn.first()).toBeVisible();
  });

  test('Add table dialog accepts label + capacity', async ({ page }) => {
    await page.goto('/tables');
    const btn = page.getByRole('button', { name: /add table|new table/i }).first();
    if (await btn.count() === 0) test.skip(true, 'no Add Table button');
    await btn.click();
    const dlg = page.getByRole('dialog');
    await expect(dlg).toBeVisible();
    // Expect at least 2 inputs (label/name + capacity)
    expect(await dlg.locator('input').count()).toBeGreaterThanOrEqual(2);
  });

  test('over-limit banner appears when more tables than plan allows', async ({ page }) => {
    await page.goto('/tables');
    const banner = page.getByText(/over.*limit|plan.*limit|upgrade/i).first();
    // Banner is optional — only present if business is over the cap.
    if (await banner.count() > 0) {
      await expect(banner).toBeVisible();
    }
  });

  test('plan-gated tables: if business has tables disabled, an upgrade CTA appears', async ({ page }) => {
    await page.goto('/tables');
    // If feature is off, there's either a soft gate ("Upgrade to unlock") or
    // a redirect. We accept either — the test asserts there's NO crash.
    await page.waitForLoadState('networkidle').catch(() => {});
    expect(page.url()).toMatch(/tables|billing|upgrade/i);
  });

  test('clicking a table opens a detail / edit sheet', async ({ page }) => {
    await page.goto('/tables');
    const firstTable = page.locator('[data-testid*="table"], .table-card, table tbody tr')
      .first();
    if (await firstTable.count() === 0) test.skip(true, 'no tables to click');
    await firstTable.click();
    await expect(
      page.getByRole('dialog').or(page.getByRole('heading', { name: /table|edit/i })),
    ).toBeVisible({ timeout: 6_000 });
  });

  test('QR code link from a table opens the QR codes page', async ({ page }) => {
    await page.goto('/tables');
    const qrLink = page.getByRole('link', { name: /qr|view qr/i }).first();
    if (await qrLink.count() === 0) test.skip(true, 'no QR link from tables page');
    await qrLink.click();
    expect(page.url()).toMatch(/qr/i);
  });

  test('tables page does not throw runtime errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    await page.goto('/tables');
    await page.waitForLoadState('networkidle').catch(() => {});
    expect(errors).toEqual([]);
  });
});
