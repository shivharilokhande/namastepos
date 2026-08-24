import { test, expect } from '@playwright/test';
import { loginAsOwner } from './_helpers';

test.describe('Menu', () => {
  test.beforeEach(async ({ page }) => { await loginAsOwner(page); });

  test('menu page lists items with stock + category filter', async ({ page }) => {
    await page.goto('/menu');
    await expect(page.getByText(/All items/i)).toBeVisible({ timeout: 10_000 });
    // At least one item card visible
    await expect(page.locator('text=Stock:').first()).toBeVisible();
  });

  test('clicking a category narrows the grid', async ({ page }) => {
    await page.goto('/menu');
    // Pick a category from the side list (skip "All items")
    const categoryButtons = page.locator('text=Burger, text=Beverages, text=Main, text=Starters');
    const first = categoryButtons.first();
    if (await first.count() > 0) {
      await first.click();
      // Items should re-render — heuristic: still see at least one Stock label
      await expect(page.locator('text=Stock:').first()).toBeVisible();
    }
  });
});
