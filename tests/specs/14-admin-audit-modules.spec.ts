// Push 20+ regression guard for the AuditPage filter dropdown — must now
// include 'addons' and 'menu' modules so the new Push 19b/20a/20b audit
// rows are filterable.

import { test, expect } from '@playwright/test';
import { ADMIN, loginAsSuperAdmin } from './_admin_helpers';

test.describe('Audit page filters', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsSuperAdmin(page);
  });

  test('audit module filter has addons + menu options', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/audit');
    await expect(page.getByRole('heading', { name: /audit/i })).toBeVisible();
    // The Module select is the first <select> on the page in the filter row.
    const moduleSelect = page.locator('select').first();
    const options = await moduleSelect.locator('option').allTextContents();
    expect(options.map((o) => o.trim().toLowerCase())).toEqual(
      expect.arrayContaining(['addons', 'menu'])
    );
  });
});
