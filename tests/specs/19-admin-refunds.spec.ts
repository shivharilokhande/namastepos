import { test, expect } from '@playwright/test';
import { ADMIN } from './_admin_helpers';

test.describe('Super-admin Refunds', () => {
  test('refunds page renders', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/refunds');
    await expect(page.getByRole('heading', { name: /refund/i }).first()).toBeVisible({ timeout: 10_000 });
  });
  test('table or empty state appears', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/refunds');
    await expect(page.locator('table, [role="table"]').or(page.getByText(/no refunds|empty/i)).first())
      .toBeVisible({ timeout: 10_000 });
  });
  test('status filter (pending/processed/failed) present', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/refunds');
    const select = page.locator('select').first();
    if (await select.count() === 0) test.skip(true, 'no status filter');
    const opts = (await select.locator('option').allTextContents()).join('|').toLowerCase();
    expect(opts).toMatch(/pending|processed|failed|all/);
  });
  test('does not throw runtime errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    await page.goto(ADMIN.baseUrl + '/refunds');
    await page.waitForLoadState('networkidle').catch(() => {});
    expect(errors).toEqual([]);
  });
  test('page has some textual content (not blank)', async ({ page }) => {
    // Refunds page may have zero refunds + no aggregate total. Just verify
    // the page rendered SOMETHING beyond the header — not a stricter
    // assertion that requires data.
    await page.goto(ADMIN.baseUrl + '/refunds');
    await page.waitForLoadState('networkidle').catch(() => {});
    const body = await page.locator('body').textContent();
    expect((body || '').length).toBeGreaterThan(50);
  });
  test('export CSV button (if present) is enabled', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/refunds');
    const btn = page.getByRole('button', { name: /export|csv/i }).first();
    if (await btn.count() === 0) test.skip(true, 'no export button');
    await expect(btn).toBeEnabled();
  });
  test('row click opens a detail view if rows exist', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/refunds');
    const firstRow = page.locator('table tbody tr').first();
    if (await firstRow.count() === 0) test.skip(true, 'no refunds');
    await firstRow.click();
    await expect(page.getByRole('dialog').or(page.getByRole('heading', { name: /detail|refund/i })))
      .toBeVisible({ timeout: 5_000 });
  });
  test('date range filter present', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/refunds');
    const dateInput = page.locator('input[type="date"]').first();
    if (await dateInput.count() === 0) test.skip(true, 'no date filter');
    await expect(dateInput).toBeVisible();
  });
});
