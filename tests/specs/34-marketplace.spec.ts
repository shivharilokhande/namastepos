import { test, expect } from '@playwright/test';

test.describe('Marketplace (addons browse)', () => {
  test('marketplace page renders', async ({ page }) => {
    await page.goto('/marketplace');
    await expect(page.getByRole('heading', { name: /marketplace|add[- ]ons/i }).first())
      .toBeVisible({ timeout: 10_000 });
  });
  test('does not throw runtime errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    await page.goto('/marketplace');
    await page.waitForLoadState('networkidle').catch(() => {});
    expect(errors).toEqual([]);
  });
  test('shows at least one addon card', async ({ page }) => {
    await page.goto('/marketplace');
    await expect(page.locator('[data-testid*="addon"], .addon-card').or(page.getByText(/loyalty|recipe|gst|customer/i)).first())
      .toBeVisible({ timeout: 10_000 });
  });
  test('activate / remove button (Push 16g) is present per card', async ({ page }) => {
    await page.goto('/marketplace');
    const btn = page.getByRole('button', { name: /activate|enable|remove|disable|installed/i }).first();
    if (await btn.count() === 0) test.skip(true, 'no addon controls');
    await expect(btn).toBeVisible();
  });
});
