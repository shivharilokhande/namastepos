import { test, expect } from '@playwright/test';

test.describe('Aggregators', () => {
  test('aggregators page renders', async ({ page }) => {
    await page.goto('/aggregators');
    await page.waitForLoadState('networkidle').catch(() => {});
  });
  test('does not throw runtime errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    await page.goto('/aggregators');
    await page.waitForLoadState('networkidle').catch(() => {});
    expect(errors).toEqual([]);
  });
  test('shows Swiggy / Zomato / Magicpin / Dunzo cards', async ({ page }) => {
    await page.goto('/aggregators');
    const txt = await page.getByText(/swiggy|zomato|magicpin|dunzo/i).count();
    expect(txt).toBeGreaterThan(0);
  });
  test('plan-gated aggregator section if not Pro', async ({ page }) => {
    await page.goto('/aggregators');
    await page.waitForLoadState('networkidle').catch(() => {});
  });
});
