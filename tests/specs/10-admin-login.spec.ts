// Super-admin smoke tests: login page renders, auth rejects bad creds, real
// admin can sign in and land on the customers page.

import { test, expect } from '@playwright/test';
import { ADMIN, loginAsSuperAdmin } from './_admin_helpers';

// This spec EXERCISES the login flow itself — so we opt out of the shared
// storageState that the rest of the admin project uses. Each test in this
// file starts with an empty cookie jar and an empty localStorage.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('Super-admin auth', () => {
  test('login page renders', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/login');
    await expect(page.getByRole('button', { name: /sign in|log in/i })).toBeVisible();
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/password/i)).toBeVisible();
  });

  test('rejects bad credentials', async ({ page }) => {
    await page.goto(ADMIN.baseUrl + '/login');
    await page.getByLabel(/email/i).fill('not-real@example.com');
    await page.getByLabel(/password/i).fill('wrong');
    await page.getByRole('button', { name: /sign in|log in/i }).click();
    // We expect to STAY on /login, with an error message somewhere on screen.
    await page.waitForTimeout(1500);
    expect(page.url()).toContain('/login');
  });

  test('real admin signs in', async ({ page }) => {
    await loginAsSuperAdmin(page);
    expect(page.url()).not.toContain('/login');
  });
});
