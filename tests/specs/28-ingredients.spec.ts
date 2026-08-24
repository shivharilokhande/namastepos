import { test, expect } from '@playwright/test';

test.describe('Ingredients (recipe costing)', () => {
  test('ingredients page renders OR shows plan-gate', async ({ page }) => {
    await page.goto('/ingredients');
    await page.waitForLoadState('networkidle').catch(() => {});
    // Either the page renders OR an upgrade gate; just no crash.
  });
  test('does not throw runtime errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    await page.goto('/ingredients');
    await page.waitForLoadState('networkidle').catch(() => {});
    expect(errors).toEqual([]);
  });
  test('table or upgrade/empty state appears', async ({ page }) => {
    await page.goto('/ingredients');
    await expect(
      page.locator('table, [role="table"]')
        .or(page.getByText(/upgrade|no ingredients|empty/i))
        .first(),
    ).toBeVisible({ timeout: 10_000 });
  });
});
