import { test, expect } from '@playwright/test';
import { loginAsOwner } from './_helpers';

test.describe('Reports — Income / Expense / Invoice registers', () => {
  test.beforeEach(async ({ page }) => { await loginAsOwner(page); });

  for (const tab of ['Income register', 'Expense register', 'Invoice register'] as const) {
    test(`${tab} tab loads + exports`, async ({ page }) => {
      await page.goto('/reports');
      await page.getByRole('button', { name: tab }).click();

      // Header card title from the RegisterHeader component
      const titleByTab = {
        'Income register':  /Income Register/,
        'Expense register': /Expense Register/,
        'Invoice register': /Tax Invoice Register/,
      }[tab];
      await expect(page.getByText(titleByTab).first()).toBeVisible({ timeout: 10_000 });

      // Export each format
      for (const fmt of [
        { btn: /Export PDF/i,   ext: 'pdf' },
        { btn: /Export Excel/i, ext: 'xlsx' },
        { btn: /Export CSV/i,   ext: 'csv'  },
      ]) {
        const dl = page.waitForEvent('download');
        await page.getByRole('button', { name: fmt.btn }).click();
        const file = await dl;
        expect(file.suggestedFilename()).toMatch(new RegExp(`\\.${fmt.ext}$`));
      }
    });
  }

  test('expense register shows the per-category summary card', async ({ page }) => {
    await page.goto('/reports');
    await page.getByRole('button', { name: 'Expense register' }).click();
    // Either there are expenses (show "By category" card) or empty state.
    // "By category" alone collides with the page subtitle ("…grouped by
    // category…"), so pin to the actual CardTitle heading.
    const summaryHeading = page.getByRole('heading', { name: /^By category$/i });
    const empty = page.getByText('No expenses in this range.');
    await expect(summaryHeading.or(empty)).toBeVisible({ timeout: 10_000 });
  });
});
