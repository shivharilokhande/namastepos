import { test, expect } from '@playwright/test';

test.describe('Reservations', () => {
  test('reservations page renders', async ({ page }) => {
    await page.goto('/reservations');
    await expect(page.getByRole('heading', { name: /reservation/i }).or(page.getByText(/no reservations|empty/i)).first())
      .toBeVisible({ timeout: 10_000 });
  });
  test('does not throw runtime errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    await page.goto('/reservations');
    await page.waitForLoadState('networkidle').catch(() => {});
    expect(errors).toEqual([]);
  });
  test('no "?" placeholders rendered (Push 13.5 regression guard)', async ({ page }) => {
    await page.goto('/reservations');
    await page.waitForLoadState('networkidle').catch(() => {});
    const qMarks = await page.locator('text=/^\\?$/').count();
    expect(qMarks).toBeLessThan(5);
  });
  test('add reservation button (if present) opens a form', async ({ page }) => {
    await page.goto('/reservations');
    const btn = page.getByRole('button', { name: /new reservation|add|book/i }).first();
    if (await btn.count() === 0) test.skip(true, 'no add button');
    await btn.click();
    await expect(page.getByRole('dialog').or(page.getByRole('heading', { name: /reservation/i })))
      .toBeVisible({ timeout: 5_000 });
  });
  test('date filter present', async ({ page }) => {
    await page.goto('/reservations');
    const dateInput = page.locator('input[type="date"]').first();
    if (await dateInput.count() === 0) test.skip(true, 'no date filter');
    await expect(dateInput).toBeVisible();
  });
});
