// Super-admin Finance page — KPIs, MRR chart, outstanding-invoices section,
// Push 20c export buttons.

import { test, expect } from '@playwright/test';
import { ADMIN, loginAsSuperAdmin } from './_admin_helpers';

test.describe('Super-admin finance', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsSuperAdmin(page);
  });

  test('finance page renders', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/finance');
    await expect(page.getByRole('heading', { name: /^finance$/i })).toBeVisible();
    await expect(page.locator('text=/MRR \\(now\\)/i')).toBeVisible();
    // Page subtitle contains "active subscriptions" and the KPI tile uses
    // "Active subs" — match the tile exactly to avoid strict-mode collision.
    await expect(page.getByText('Active subs', { exact: true })).toBeVisible();
  });

  test('outstanding invoices section + aging buckets render', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/finance');
    await expect(page.locator('text=/outstanding invoices/i')).toBeVisible({ timeout: 10_000 });
    // 4 aging buckets: 0-30, 31-60, 61-90, 90+
    await expect(page.locator('text=/0-30 days/i')).toBeVisible();
    await expect(page.locator('text=/31-60 days/i')).toBeVisible();
    await expect(page.locator('text=/61-90 days/i')).toBeVisible();
    await expect(page.locator('text=/90\\+ days/i')).toBeVisible();
  });

  test('Push 20c — MRR/Outstanding/Summary CSV buttons all present', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/finance');
    await expect(page.getByRole('button', { name: /MRR CSV/i })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /Outstanding CSV/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Summary CSV/i })).toBeVisible();
  });
});
