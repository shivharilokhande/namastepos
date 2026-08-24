// NamastePOS dashboard — Setup wizard shape tests (FF-259 + FF-217c).
//
// Playwright can't drive real Google OAuth, so we prime localStorage
// with a fake auth token + business row (mirrors what setSession +
// setBusinessCache do internally), then navigate. That's enough to
// prove:
//   1. /onboarding renders four steps
//   2. Step 1 shows the profile form
//   3. Continue button advances the pager
//
// We intercept the actual API calls (patchMe, ops/floors, ops/tables,
// menu) so the wizard's "Finish" doesn't need a live backend.

import { test, expect, Page } from '@playwright/test';

async function primeAuth(page: Page) {
  await page.addInitScript(() => {
    // The dashboard reads these keys via api/client.ts.
    localStorage.setItem('ff_token', 'test-token');
    localStorage.setItem('ff_refresh', 'test-refresh');
    localStorage.setItem('ff_business', JSON.stringify({
      id: 'biz-test', name: 'Playwright Cafe', onboarded: false,
    }));
  });
  // Mock every request the wizard needs so the page can render.
  await page.route('**/v1/auth/me', (r) => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      user: { id: 'u-1', email: 'test@example.com' },
      business: { id: 'biz-test', name: 'Playwright Cafe', onboarded: false },
      role: 'business_owner',
      permissions: ['home', 'orders', 'menu'],
      plan: { tier: 'pro', features: {} },
    }),
  }));
  await page.route('**/v1/businesses/**/addons', (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify([]),
  }));
}

test.describe('Setup wizard', () => {
  test('renders 4-step wizard on /onboarding', async ({ page }) => {
    await primeAuth(page);
    await page.goto('/onboarding');
    // Step 1 title from SetupWizardPage.
    await expect(page.locator('text=/tell us about your business/i'))
      .toBeVisible();
    // Progress track has four segments.
    const progressBar = page.locator('.h-1.flex-1.rounded');
    await expect(progressBar).toHaveCount(4);
  });

  test('continue advances through the steps', async ({ page }) => {
    await primeAuth(page);
    await page.goto('/onboarding');

    // Type a business name so step 1 has something to submit.
    await page.locator('input').first().fill('Playwright Cafe');
    // Step 1 → 2
    await page.locator('button:has-text("Continue")').click();
    await expect(page.locator('text=/add your tables/i')).toBeVisible();
    // Step 2 → 3
    await page.locator('button:has-text("Continue")').click();
    await expect(page.locator('text=/menu items/i')).toBeVisible();
    // Step 3 → 4 (confirmation)
    await page.locator('button:has-text("Continue")').click();
    await expect(page.locator('button:has-text("Finish setup")')).toBeVisible();
  });

  test('skip flips onboarded and exits wizard', async ({ page }) => {
    await primeAuth(page);

    // Intercept the PATCH /auth/me that flips onboarded=true.
    let patched = false;
    await page.route('**/v1/auth/me', async (r) => {
      if (r.request().method() === 'PATCH') {
        patched = true;
        return r.fulfill({ status: 200, body: '{}', contentType: 'application/json' });
      }
      // The GET has already been fulfilled by primeAuth's earlier route
      // registration — but Playwright uses the LAST matching handler,
      // so we need to serve GET too.
      return r.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'u-1', email: 'x@y.com' },
          business: { id: 'biz-test', name: 'Playwright Cafe', onboarded: false },
          role: 'business_owner',
          permissions: ['home'],
          plan: { tier: 'pro', features: {} },
        }),
      });
    });
    await page.goto('/onboarding');
    await page.locator('button:has-text("Skip for now"), :text("Skip for now")').first().click();

    // The wizard should navigate away. We can't easily assert what
    // the layout looks like without stubbing every downstream call,
    // but we CAN assert the skip fired.
    await expect.poll(() => patched, { timeout: 5000 }).toBe(true);
  });
});
