import { test, expect } from '@playwright/test';

test.describe('KOT (kitchen order ticket)', () => {
  test('kot page renders', async ({ page }) => {
    await page.goto('/kot');
    await expect(page.getByRole('heading', { name: /KOT|tickets/i }).or(page.getByText(/no tickets|empty/i)).first())
      .toBeVisible({ timeout: 10_000 });
  });
  test('does not throw runtime errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    await page.goto('/kot');
    await page.waitForLoadState('networkidle').catch(() => {});
    expect(errors).toEqual([]);
  });
  test('print KOT button (if present) is clickable', async ({ page }) => {
    await page.goto('/kot');
    const btn = page.getByRole('button', { name: /print/i }).first();
    if (await btn.count() === 0) test.skip(true, 'no print button');
    await expect(btn).toBeEnabled();
  });
  test('filter by station/section if present', async ({ page }) => {
    await page.goto('/kot');
    const sel = page.locator('select').first();
    if (await sel.count() === 0) test.skip(true, 'no station filter');
    await expect(sel).toBeVisible();
  });
});
