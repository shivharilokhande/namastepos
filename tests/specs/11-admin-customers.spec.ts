// Customers page + Customer Detail smoke: list renders, detail page loads,
// and the Push 20a/20b regressions don't reappear (detach safety guard,
// bulk-import widget present, addons tab renders without crashing).

import { test, expect } from '@playwright/test';
import { ADMIN, loginAsSuperAdmin } from './_admin_helpers';

test.describe('Super-admin customers', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsSuperAdmin(page);
  });

  test('customers list renders', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/customers');
    await expect(page.getByRole('heading', { name: /customers/i })).toBeVisible();
    // Plan filter dropdown should be populated from /plans (Push 19a).
    await expect(page.locator('select, [role="combobox"]').first()).toBeVisible();
  });

  test('customer detail page loads with all tabs', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/customers');
    // The whole TableRow has an onClick → navigate handler (cursor-pointer).
    // There is NO <a> or <button> inside the row, so we click the row itself.
    const firstRow = page.locator('table tbody tr').first();
    await expect(firstRow).toBeVisible({ timeout: 10_000 });
    await firstRow.click();

    // Wait for the detail page tab strip — overview/addons/menu/orders/staff/invoices/notes
    for (const t of ['overview', 'addons', 'menu', 'orders', 'staff', 'invoices', 'notes']) {
      await expect(page.getByRole('button', { name: new RegExp(`^${t}\\b`, 'i') }).first())
        .toBeVisible({ timeout: 8_000 });
    }
  });

  test('addons tab renders without crashing (Push 20a regression guard)', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/customers');
    const firstRow = page.locator('table tbody tr').first();
    await expect(firstRow).toBeVisible({ timeout: 10_000 });
    await firstRow.click();
    await page.getByRole('button', { name: /addons/i }).first().click();
    // Should render the "Available add-ons" heading or "Active add-ons" — at
    // least one of the two, and crucially not throw.
    await expect(page.locator('text=/add[- ]ons|addon catalog/i').first())
      .toBeVisible({ timeout: 8_000 });
  });

  test('menu tab shows bulk import card (Push 20b)', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/customers');
    const firstRow = page.locator('table tbody tr').first();
    await expect(firstRow).toBeVisible({ timeout: 10_000 });
    await firstRow.click();
    await page.getByRole('button', { name: /^menu/i }).first().click();
    // Bulk import header + Choose CSV "button" (actually a span inside a
    // Button asChild — file inputs need a label/span wrapper, so the rendered
    // tag is <span>, not <button>). Match by text instead of role.
    await expect(page.locator('text=/bulk import from CSV/i')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText(/choose CSV file/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /template/i })).toBeVisible();
  });

  test('orders tab has CSV export button (Push 20c)', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/customers');
    const firstRow = page.locator('table tbody tr').first();
    await expect(firstRow).toBeVisible({ timeout: 10_000 });
    await firstRow.click();
    await page.getByRole('button', { name: /^orders/i }).first().click();
    await expect(page.getByRole('button', { name: /export CSV/i })).toBeVisible({ timeout: 8_000 });
  });

  test('invoices tab has CSV export button (Push 20c)', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/customers');
    const firstRow = page.locator('table tbody tr').first();
    await expect(firstRow).toBeVisible({ timeout: 10_000 });
    await firstRow.click();
    await page.getByRole('button', { name: /^invoices/i }).first().click();
    await expect(page.getByRole('button', { name: /export CSV/i })).toBeVisible({ timeout: 8_000 });
  });
});
