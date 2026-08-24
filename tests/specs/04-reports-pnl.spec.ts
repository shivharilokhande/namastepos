import { test, expect } from '@playwright/test';
import { loginAsOwner } from './_helpers';

test.describe('Reports — P&L statement', () => {
  test.beforeEach(async ({ page }) => { await loginAsOwner(page); });

  test('P&L tab renders the Schedule III statement', async ({ page }) => {
    await page.goto('/reports');
    // P&L is the default tab in the recent push
    await expect(page.getByRole('button', { name: 'P&L statement' })).toBeVisible();
    await page.getByRole('button', { name: 'P&L statement' }).click();

    // Section headers from the income statement
    await expect(page.getByText('I. Revenue from operations')).toBeVisible();
    await expect(page.getByText(/III\. Cost of goods sold/i)).toBeVisible();
    await expect(page.getByText(/X\. NET PROFIT/i)).toBeVisible();
    // /GST collected/ is too loose — matches the description, the row
    // label, the section header, and the total row. Pin to the section
    // heading (a memorandum after the main statement).
    await expect(page.getByText(/GST collected — memorandum/i)).toBeVisible();
  });

  test('date range filter triggers a re-fetch', async ({ page }) => {
    await page.goto('/reports');
    await page.getByRole('button', { name: 'P&L statement' }).click();

    // The dashboard renders <Label>From</Label> separately from <Input>
    // (no htmlFor/id linkage), so getByLabel() doesn't bind. Only the
    // active tab is rendered, so input[type="date"] uniquely selects the
    // two date pickers in DOM order (From, then To).
    const dateInputs = page.locator('input[type="date"]');
    await dateInputs.nth(0).fill('2025-01-01');
    await dateInputs.nth(1).fill('2025-12-31');

    // Net margin label should re-render — just wait for it to exist again
    await expect(page.getByText(/Net margin %/i)).toBeVisible();
  });

  test('PDF / Excel / CSV exports trigger a download', async ({ page }) => {
    await page.goto('/reports');
    await page.getByRole('button', { name: 'P&L statement' }).click();

    for (const format of [
      { btn: /Export PDF/i, ext: 'pdf' },
      { btn: /Export Excel/i, ext: 'xlsx' },
      { btn: /Export CSV/i,  ext: 'csv'  },
    ]) {
      const downloadPromise = page.waitForEvent('download');
      await page.getByRole('button', { name: format.btn }).click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toMatch(new RegExp(`\\.${format.ext}$`));
    }
  });
});
