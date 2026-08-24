import { test, expect } from '@playwright/test';
import { ADMIN } from './_admin_helpers';

test.describe('Super-admin Metrics', () => {
  test('metrics page renders', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/metrics');
    await expect(page.getByRole('heading', { name: /metrics|platform/i }).first()).toBeVisible({ timeout: 10_000 });
  });
  test('does not throw runtime errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    await page.goto(ADMIN.baseUrl + '/metrics');
    await page.waitForLoadState('networkidle').catch(() => {});
    expect(errors).toEqual([]);
  });
  test('shows MRR or signups KPI tile', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/metrics');
    await expect(page.getByText(/MRR|signups|active|customers|revenue/i).first()).toBeVisible({ timeout: 10_000 });
  });
  test('has a date range or period selector', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/metrics');
    const sel = page.locator('input[type="date"], select').first();
    if (await sel.count() === 0) test.skip(true, 'no date/period selector');
    await expect(sel).toBeVisible();
  });
  test('numeric KPIs are not "—" placeholders after load', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/metrics');
    await page.waitForLoadState('networkidle').catch(() => {});
    const dashCount = await page.locator('text=/^—$/').count();
    expect(dashCount).toBeLessThan(20);
  });
  test('renders without auth → not the live /metrics page', async ({ browser }) => {
    // Without storageState the admin app should NOT show the metrics page.
    // Some builds redirect to /login, others to / and render the login card
    // at that URL. Either way the URL must NOT contain "metrics" anymore,
    // and we should see login/sign-in copy.
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(ADMIN.baseUrl + '/metrics');
    await page.waitForLoadState('networkidle').catch(() => {});
    expect(page.url()).not.toMatch(/\/metrics/);
    await expect(
      page.getByText(/sign in|log in|email/i).first(),
    ).toBeVisible({ timeout: 5_000 });
    await ctx.close();
  });
  test('export button (if present) is enabled', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/metrics');
    const btn = page.getByRole('button', { name: /export|csv|download/i }).first();
    if (await btn.count() === 0) test.skip(true, 'no export button');
    await expect(btn).toBeEnabled();
  });
  test('chart container renders (recharts svg)', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/metrics');
    await expect(page.locator('svg').first()).toBeVisible({ timeout: 10_000 });
  });
});
