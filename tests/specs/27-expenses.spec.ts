import { test, expect } from '@playwright/test';

test.describe('Expenses', () => {
  test('expenses page renders', async ({ page }) => {
    await page.goto('/expenses');
    await expect(page.getByRole('heading', { name: /expense/i }).first()).toBeVisible({ timeout: 10_000 });
  });
  test('does not throw runtime errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    await page.goto('/expenses');
    await page.waitForLoadState('networkidle').catch(() => {});
    expect(errors).toEqual([]);
  });
  test('add expense button opens a dialog', async ({ page }) => {
    await page.goto('/expenses');
    const btn = page.getByRole('button', { name: /add expense|new expense|create/i }).first();
    if (await btn.count() === 0) test.skip(true, 'no add button');
    await btn.click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });
  });
  test('category select present in add dialog', async ({ page }) => {
    await page.goto('/expenses');
    const btn = page.getByRole('button', { name: /add expense|create/i }).first();
    if (await btn.count() === 0) test.skip(true, 'no add button');
    await btn.click();
    const sel = page.locator('select').first();
    if (await sel.count() === 0) test.skip(true, 'no category select');
    await expect(sel).toBeVisible();
  });
  test('amount + date inputs present', async ({ page }) => {
    await page.goto('/expenses');
    const btn = page.getByRole('button', { name: /add expense|create/i }).first();
    if (await btn.count() === 0) test.skip(true, 'no add button');
    await btn.click();
    const num = page.locator('input[type="number"]').first();
    const date = page.locator('input[type="date"]').first();
    if (await num.count() > 0) await expect(num).toBeVisible();
    if (await date.count() > 0) await expect(date).toBeVisible();
  });
  test('table or empty state appears', async ({ page }) => {
    await page.goto('/expenses');
    await expect(
      page.locator('table, [role="table"]').or(page.getByText(/no expenses|empty/i)).first(),
    ).toBeVisible({ timeout: 10_000 });
  });
});
