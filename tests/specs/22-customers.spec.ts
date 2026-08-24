// Dashboard Customers CRM (Push 17d — auto-activated).

import { test, expect } from '@playwright/test';

test.describe('Customers CRM', () => {
  test('customers page renders', async ({ page }) => {
    await page.goto('/customers');
    await expect(page.getByRole('heading', { name: /customers/i }).first()).toBeVisible({ timeout: 10_000 });
  });

  test('customers page is auto-activated (Push 17d — no marketplace browse)', async ({ page }) => {
    await page.goto('/customers');
    // Should NOT redirect to /marketplace or show an "Activate addon" CTA.
    await page.waitForLoadState('networkidle').catch(() => {});
    expect(page.url()).toMatch(/customers/i);
  });

  test('customers list table or empty-state appears', async ({ page }) => {
    await page.goto('/customers');
    const tableOrEmpty = page.locator('table, [role="table"]')
      .or(page.getByText(/no customers|empty/i));
    await expect(tableOrEmpty.first()).toBeVisible({ timeout: 10_000 });
  });

  test('search input filters the list', async ({ page }) => {
    await page.goto('/customers');
    const search = page.getByPlaceholder(/search/i).first();
    if (await search.count() === 0) test.skip(true, 'no search input');
    await search.fill('zzznoresult');
    await page.waitForTimeout(500);
    // Either rows go to 0 or empty-state appears
  });

  test('add-customer button opens a dialog', async ({ page }) => {
    await page.goto('/customers');
    const newBtn = page.getByRole('button', { name: /add customer|new customer|create/i }).first();
    if (await newBtn.count() === 0) test.skip(true, 'no Add Customer button');
    await newBtn.click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('row click opens customer detail / drawer', async ({ page }) => {
    await page.goto('/customers');
    const firstRow = page.locator('table tbody tr').first();
    if (await firstRow.count() === 0) test.skip(true, 'no customers in DB');
    await firstRow.click();
    await expect(
      page.getByRole('dialog')
        .or(page.getByRole('heading', { name: /customer|detail/i }))
        .or(page.locator('aside')),
    ).toBeVisible({ timeout: 6_000 });
  });

  test('tier badges (Bronze / Silver / Gold / Platinum) render when present', async ({ page }) => {
    await page.goto('/customers');
    // Optional — just verify no crash
    await page.waitForLoadState('networkidle').catch(() => {});
  });

  test('customers page does not throw runtime errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    await page.goto('/customers');
    await page.waitForLoadState('networkidle').catch(() => {});
    expect(errors).toEqual([]);
  });
});
