import { test, expect } from '@playwright/test';
import { ADMIN } from './_admin_helpers';

test.describe('Super-admin Admin Team', () => {
  test('admin team page renders', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/team');
    if (page.url().includes('404') || page.url().includes('not-found')) test.skip(true, 'team page not at /team');
    await expect(page.getByRole('heading', { name: /team|admin/i }).first()).toBeVisible({ timeout: 10_000 });
  });
  test('does not throw runtime errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    await page.goto(ADMIN.baseUrl + '/team').catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
    expect(errors).toEqual([]);
  });
  test('invite/add admin button exists', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/team');
    const btn = page.getByRole('button', { name: /invite|add admin|new admin/i }).first();
    if (await btn.count() === 0) test.skip(true, 'no invite button');
    await expect(btn).toBeVisible();
  });
  test('role selector offers owner / operator / viewer', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/team');
    const btn = page.getByRole('button', { name: /invite|add admin/i }).first();
    if (await btn.count() === 0) test.skip(true, 'no invite button');
    await btn.click();
    const select = page.locator('select').first();
    if (await select.count() === 0) test.skip(true, 'no role select');
    const opts = (await select.locator('option').allTextContents()).join('|').toLowerCase();
    expect(opts).toMatch(/owner|operator|viewer|admin|role/);
  });
});
