import { test, expect } from '@playwright/test';
import { apiAs, loginAsOwner, getBusinessId } from './_helpers';

test.describe('Tax invoices', () => {
  test.beforeEach(async ({ page }) => { await loginAsOwner(page); });

  test('list page loads and date filter works', async ({ page }) => {
    await page.goto('/invoices');
    await expect(page.getByText(/Tax Invoices/i).first()).toBeVisible();

    const today = new Date().toISOString().slice(0, 10);
    // <Label>From</Label> isn't htmlFor-linked to the date Input. The page
    // only has one set of date pickers (From, then To in DOM order).
    const dateInputs = page.locator('input[type="date"]');
    await dateInputs.nth(0).fill('2025-01-01');
    await dateInputs.nth(1).fill(today);
    await page.getByRole('button', { name: /Refresh/i }).click();

    // Either rows show, or the empty-state copy
    await expect(
      page.getByText(/Total invoiced|No invoices in this range/i).first()
    ).toBeVisible();
  });

  test('clicking an invoice opens the detail dialog and PDF download works', async ({ page }) => {
    await page.goto('/invoices');
    // Find any monospace invoice-no link in the list. Skip the test if none.
    const firstInv = page.locator('button.font-mono').first();
    const count = await firstInv.count();
    test.skip(count === 0, 'no invoices in DB — collect an order first to generate one');
    await firstInv.click();

    // Detail dialog renders
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText(/Recipient \(Bill to/i)).toBeVisible();
    await expect(page.getByText(/HSN-wise summary|HSN/i).first()).toBeVisible();

    // Trigger PDF download
    const dl = page.waitForEvent('download');
    await page.getByRole('button', { name: /Download PDF/i }).click();
    const file = await dl;
    expect(file.suggestedFilename()).toMatch(/\.pdf$/);
  });

  test('auto-issued from a collected order (smoke test via API)', async ({ page }) => {
    // The order-collect path should auto-issue. We can't easily collect
    // an order without state from the dashboard, but we CAN check the
    // list endpoint returns rows for issued invoices. Resolve the active
    // owner's businessId from localStorage so the call doesn't 403.
    const businessId = await getBusinessId(page);
    const { status, body } = await apiAs(page, `/businesses/${businessId}/tax-invoices`);
    expect(status).toBe(200);
    expect(body).toHaveProperty('invoices');
    expect(Array.isArray(body.invoices)).toBe(true);
  });
});
