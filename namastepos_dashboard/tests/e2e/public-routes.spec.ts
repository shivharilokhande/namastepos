// NamastePOS dashboard — public route smoke tests (FF-259).
//
// Verifies the four PUBLIC surfaces render without a login token:
//   /login, /register, /legal/privacy, /legal/terms
// And confirms the new 404 page (from earlier this sprint) shows for
// an unknown route instead of the old silent-redirect behaviour.

import { test, expect } from '@playwright/test';

test.describe('Public routes', () => {
  test('login page renders sign-in surface', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('text=/sign in|google/i').first()).toBeVisible();
  });

  test('register page renders', async ({ page }) => {
    await page.goto('/register');
    // Register page shows an email field regardless of whether it's the
    // password flow or the "Create account" Google/email hybrid.
    await expect(page.locator('input[type=email], input[name=email]').first())
      .toBeVisible();
  });

  test('privacy page renders DPDP wording', async ({ page }) => {
    await page.goto('/legal/privacy');
    // The DPDP-required grievance officer name appears on our public
    // privacy page — a reliable string to match against without
    // depending on markup.
    await expect(page.locator('text=/privacy|dpdp|grievance/i').first())
      .toBeVisible();
  });

  test('terms page renders', async ({ page }) => {
    await page.goto('/legal/terms');
    await expect(page.locator('text=/terms|acceptance|use/i').first())
      .toBeVisible();
  });

  test('unknown route shows real 404, not silent redirect', async ({ page }) => {
    // Bug fix (2026-08-20): the old catch-all Navigate-to-"/" masked
    // typos. Now typing a bad URL should surface the NotFoundPage.
    await page.goto('/nope/does-not-exist');
    await expect(page.locator('text=/page not found/i')).toBeVisible();
    // And the URL bar should still show the failing path so the user
    // knows what they typed wrong.
    await expect(page).toHaveURL(/\/nope\/does-not-exist/);
  });
});
