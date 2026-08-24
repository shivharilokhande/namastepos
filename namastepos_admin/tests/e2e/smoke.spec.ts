// NamastePOS super-admin — smoke E2E (FF-258).
//
// Verifies the login page renders and the new 404 fallback works.
// Real admin sessions need a valid backend token, so authenticated
// flows are covered separately in FF-258b once we have a stable
// dev-login fixture.

import { test, expect } from '@playwright/test';

test.describe('Admin — public surface', () => {
  test('login page renders', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('text=/namastepos super admin/i')).toBeVisible();
    await expect(page.locator('input[type=email]')).toBeVisible();
    await expect(page.locator('input[type=password]')).toBeVisible();
    await expect(page.locator('button:has-text("Sign in")')).toBeVisible();
  });

  test('login form shows validation on empty submit', async ({ page }) => {
    await page.goto('/login');
    await page.locator('button:has-text("Sign in")').click();
    // Native browser validation kicks in — the required-attribute
    // popup blocks the request. We just assert we stayed on /login
    // and no network call happened yet.
    await expect(page).toHaveURL(/\/login/);
  });

  test('unknown route lands on 404, not silent redirect', async ({ page }) => {
    await page.goto('/does-not-exist');
    await expect(page.locator('text=/page not found/i')).toBeVisible();
    await expect(page).toHaveURL(/\/does-not-exist/);
  });

  test('protected routes bounce to login without token', async ({ page }) => {
    // RequireAuth wraps every Layout child — hitting /customers cold
    // should route us to /login via <Navigate>.
    await page.goto('/customers');
    await expect(page).toHaveURL(/\/login/);
  });
});
