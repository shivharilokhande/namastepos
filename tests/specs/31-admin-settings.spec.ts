import { test, expect } from '@playwright/test';
import { ADMIN } from './_admin_helpers';

test.describe('Super-admin Settings', () => {
  test('settings page renders', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/settings');
    await expect(page.getByRole('heading', { name: /settings/i }).first()).toBeVisible({ timeout: 10_000 });
  });
  test('does not throw runtime errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    await page.goto(ADMIN.baseUrl + '/settings');
    await page.waitForLoadState('networkidle').catch(() => {});
    expect(errors).toEqual([]);
  });
  test('shows at least one form section', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/settings');
    await expect(page.locator('input, select, textarea').first()).toBeVisible({ timeout: 10_000 });
  });
  test('save button (if present) is enabled', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/settings');
    const btn = page.getByRole('button', { name: /save|update|apply/i }).first();
    if (await btn.count() === 0) test.skip(true, 'no save button');
    await expect(btn).toBeEnabled();
  });
  test('unauth user is gated off settings', async ({ browser }) => {
    // Admin app may redirect to /login OR root with the login card. Either
    // way, the live /settings UI should not be visible.
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(ADMIN.baseUrl + '/settings');
    await page.waitForLoadState('networkidle').catch(() => {});
    await expect(
      page.getByText(/sign in|log in|email/i).first(),
    ).toBeVisible({ timeout: 5_000 });
    await ctx.close();
  });
});
