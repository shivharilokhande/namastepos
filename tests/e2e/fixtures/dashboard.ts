// Shared page helpers for the CI E2E suite.

import { Page, expect } from '@playwright/test';
import type { SeededBusiness } from './seed';

/** Escape a seeded name so it is safe inside a locator RegExp. */
export function rx(literal: string): RegExp {
  return new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

/**
 * Log the owner in through the real login form.
 *
 * Locators are deliberately semantic, not CSS-class based. Note there is no
 * `htmlFor`/`id` pairing between <Label> and <Input> in LoginPage.tsx, so
 * getByLabel() does NOT work — we key off the placeholder and the
 * autocomplete attribute, both of which are behavioural contracts a
 * refactor is unlikely to change silently.
 *
 * IMPORTANT — DO NOT page.reload() ANYWHERE AFTER THIS.
 * The dashboard keeps its access token in a module-level variable
 * (client.ts: `let accessToken`), NOT in localStorage. Surviving a reload
 * depends on the httpOnly `ff_refresh` cookie reaching bootstrapAuth(), and
 * over plain http across two different ports that cookie is not reliably
 * replayed. Every spec therefore navigates via in-app links only, which is
 * also what a real cashier does.
 */
export async function loginAsOwner(page: Page, biz: SeededBusiness): Promise<void> {
  await page.goto('/login');

  await page.getByPlaceholder('you@example.com').fill(biz.ownerEmail);
  await page.locator('input[autocomplete="current-password"]').fill(biz.ownerPassword);

  await Promise.all([
    // Bind to the actual auth call so we fail on the login request, not 30s
    // later on a missing heading.
    page.waitForResponse(
      (r) => r.url().includes('/auth/login') && r.request().method() === 'POST',
    ),
    page.getByRole('button', { name: 'Log in' }).click(),
  ]);

  // Overview is the post-login landing page; its h1 is "Today".
  await expect(page.getByRole('heading', { name: 'Today', level: 1 })).toBeVisible();
}

/** Log a PIN staff member in via the phone + PIN panel on the login screen. */
export async function loginAsPinStaff(
  page: Page,
  staff: { phone: string; pin: string },
): Promise<void> {
  await page.goto('/login');

  await page.getByRole('button', { name: /Sign in as staff/ }).click();
  await page.getByPlaceholder('10-digit mobile number').fill(staff.phone);

  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes('/auth/staff-resolve') && r.request().method() === 'POST',
    ),
    page.getByRole('button', { name: 'Continue' }).click(),
  ]);

  // A phone that belongs to exactly one outlet skips the picker and goes
  // straight to the PIN step (LoginPage.tsx auto-selects when list.length === 1).
  const pinBox = page.getByPlaceholder('••••');
  await expect(pinBox).toBeVisible();
  await pinBox.fill(staff.pin);

  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes('/auth/pin-login') && r.request().method() === 'POST',
    ),
    page.getByRole('button', { name: 'Sign in with PIN' }).click(),
  ]);
}

/** Click a sidebar entry by its visible label and wait for the route to settle. */
export async function navigate(page: Page, label: string): Promise<void> {
  // The desktop sidebar and the (hidden) mobile drawer render the same body,
  // so scope to the visible <aside> to keep the locator strict-mode clean.
  await page.locator('aside').getByRole('link', { name: label, exact: true }).first().click();
}
