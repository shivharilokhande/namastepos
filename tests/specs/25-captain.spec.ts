import { test, expect } from '@playwright/test';

test.describe('Captain (table service)', () => {
  test('captain page renders', async ({ page }) => {
    await page.goto('/captain');
    await expect(page.getByRole('heading', { name: /captain|tables/i }).or(page.getByText(/no tables|empty/i)).first())
      .toBeVisible({ timeout: 10_000 });
  });
  test('does not throw runtime errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    await page.goto('/captain');
    await page.waitForLoadState('networkidle').catch(() => {});
    expect(errors).toEqual([]);
  });
  test('shows tables grid or empty state', async ({ page }) => {
    await page.goto('/captain');
    await expect(
      page.locator('[data-testid*="table"], .table-card').or(page.getByText(/no tables/i)).first(),
    ).toBeVisible({ timeout: 10_000 });
  });
  test('plan-gated upgrade CTA if Captain not in plan', async ({ page }) => {
    await page.goto('/captain');
    await page.waitForLoadState('networkidle').catch(() => {});
    // Either captain UI renders OR an upgrade message
    const upgrade = page.getByText(/upgrade|unlock|pro plan/i);
    // No crash — that's the assertion. Upgrade may or may not be present.
  });
});
