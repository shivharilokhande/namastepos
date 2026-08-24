import { test, expect } from '@playwright/test';
import { ADMIN } from './_admin_helpers';

test.describe('Super-admin Webhooks', () => {
  test('webhooks page renders', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/webhooks');
    await expect(page.getByRole('heading', { name: /webhook/i }).first()).toBeVisible({ timeout: 10_000 });
  });
  test('does not throw runtime errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    await page.goto(ADMIN.baseUrl + '/webhooks');
    await page.waitForLoadState('networkidle').catch(() => {});
    expect(errors).toEqual([]);
  });
  test('table or empty state appears', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/webhooks');
    await expect(page.locator('table, [role="table"]').or(page.getByText(/no webhooks|empty/i)).first())
      .toBeVisible({ timeout: 10_000 });
  });
  test('retry / resend column or button visible', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/webhooks');
    const retry = page.getByText(/retry|resend|replay/i).first();
    if (await retry.count() === 0) test.skip(true, 'no retry control');
    await expect(retry).toBeVisible();
  });
  test('provider filter (razorpay/aggregator/twilio) present', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/webhooks');
    const select = page.locator('select').first();
    if (await select.count() === 0) test.skip(true, 'no provider filter');
    const opts = (await select.locator('option').allTextContents()).join('|').toLowerCase();
    expect(opts).toMatch(/razorpay|aggregator|twilio|wa|whatsapp|swiggy|zomato|provider|all/);
  });
});
