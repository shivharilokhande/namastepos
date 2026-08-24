import { test, expect } from '@playwright/test';
import { ENV, loginAsOwner } from './_helpers';

// This spec EXERCISES the login flow itself — opt out of the shared owner
// storageState so each test starts with an empty cookie jar + localStorage.
// (Otherwise "bad password" would never land on /login to begin with.)
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('Login + session', () => {
  test('owner can sign in with email + password and lands on overview', async ({ page }) => {
    await loginAsOwner(page);
    // The business name lives in the sidebar but is hidden at narrower
    // Playwright viewports (responsive layout). Check the localStorage
    // signals instead — they're the source of truth for "logged in".
    const token = await page.evaluate(() => localStorage.getItem('ff_dash_token'));
    expect(token).toBeTruthy();
    const business = await page.evaluate(() => localStorage.getItem('ff_dash_business'));
    expect(business).toBeTruthy();
    expect(JSON.parse(business!)).toMatchObject({ id: expect.any(String) });
  });

  test('refreshing keeps the session', async ({ page }) => {
    await loginAsOwner(page);
    await page.reload();
    await expect(page).not.toHaveURL(/\/login/);
  });

  test('bad password is rejected with an inline error', async ({ page }) => {
    await page.goto('/login');
    // Dashboard <Label> isn't htmlFor-linked, so use input[type] selectors.
    await page.locator('input[type="email"]').fill(ENV.email);
    await page.locator('input[type="password"]').fill('definitely-wrong');
    await page.getByRole('button', { name: /sign in|log in/i }).click();
    // Toast or inline error
    await expect(
      page.getByText(/invalid|incorrect|unauthorized/i).first()
    ).toBeVisible({ timeout: 5_000 });
  });
});
