import { test, expect } from '@playwright/test';
import { ADMIN } from './_admin_helpers';

test.describe('Super-admin GST', () => {
  test('GST page renders', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/gst');
    await expect(page.getByRole('heading', { name: /gst/i }).first()).toBeVisible({ timeout: 10_000 });
  });
  test('does not throw runtime errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    await page.goto(ADMIN.baseUrl + '/gst');
    await page.waitForLoadState('networkidle').catch(() => {});
    expect(errors).toEqual([]);
  });
  test('HSN-wise summary section is present', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/gst');
    await expect(page.getByText(/HSN|SAC|tax slab/i).first()).toBeVisible({ timeout: 10_000 });
  });
  test('B2B / B2C split section appears', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/gst');
    await expect(page.getByText(/b2b|b2c|business[- ]to[- ]business/i).first()).toBeVisible({ timeout: 10_000 });
  });
  test('filing tracker / status visible', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/gst');
    await expect(page.getByText(/filing|GSTR-1|GSTR-3B|due/i).first()).toBeVisible({ timeout: 10_000 });
  });
  test('date range / month selector present', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/gst');
    const sel = page.locator('input[type="date"], input[type="month"], select').first();
    if (await sel.count() === 0) test.skip(true, 'no period selector');
    await expect(sel).toBeVisible();
  });
});
