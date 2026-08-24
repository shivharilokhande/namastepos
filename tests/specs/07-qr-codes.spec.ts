import { test, expect } from '@playwright/test';
import { apiAs, loginAsOwner, getBusinessId } from './_helpers';

test.describe('QR codes', () => {
  test.beforeEach(async ({ page }) => { await loginAsOwner(page); });

  test('every active table renders its QR + PNG download works', async ({ page }) => {
    await page.goto('/qr-codes');
    // Page-level <svg>.first() matches the menu hamburger icon. Wait for
    // the actual "Download PNG" button instead — its presence implies the
    // QR card mounted (with its embedded SVG) and the token was issued.
    await expect(page.getByRole('button', { name: /Download PNG/i }).first())
      .toBeVisible({ timeout: 15_000 });

    // Trigger PNG download from the first card
    const dl = page.waitForEvent('download');
    await page.getByRole('button', { name: /Download PNG/i }).first().click();
    const file = await dl;
    expect(file.suggestedFilename()).toMatch(/qr-table-.*\.png$/);
  });

  test('guest menu URL renders the menu without auth', async ({ page, context }) => {
    // Fetch a token via the API
    const businessId = await getBusinessId(page);
    const { status, body } = await apiAs(page,
      `/businesses/${businessId}/ops/tables`);
    expect(status).toBe(200);
    const firstTable = (body.tables || [])[0];
    test.skip(!firstTable, 'business has no tables');

    const tokRes = await apiAs(page,
      `/businesses/${businessId}/ops/tables/${firstTable.id}/qr`);
    expect(tokRes.status).toBe(200);
    expect(tokRes.body.token).toBeTruthy();

    // Open the guest URL in a fresh context (no auth, like a real customer)
    const guestCtx = await context.browser()!.newContext();
    const guest = await guestCtx.newPage();
    await guest.goto(`/qr/${tokRes.body.token}`);
    // welcomeTitle is a per-business setting, so don't pin to specific copy.
    // The real signal that the menu rendered is the ADD button on items.
    await expect(guest.getByRole('button', { name: /ADD/i }).first()).toBeVisible({ timeout: 10_000 });
    await guestCtx.close();
  });

  test('guest can place an order via the QR', async ({ page, context }) => {
    const businessId = await getBusinessId(page);
    const tablesRes = await apiAs(page, `/businesses/${businessId}/ops/tables`);
    const table = (tablesRes.body.tables || [])[0];
    test.skip(!table, 'business has no tables');

    const tokRes = await apiAs(page,
      `/businesses/${businessId}/ops/tables/${table.id}/qr`);
    const token = tokRes.body.token;

    const guestCtx = await context.browser()!.newContext();
    const guest = await guestCtx.newPage();
    await guest.goto(`/qr/${token}`);

    // Add the first item
    await guest.getByRole('button', { name: /ADD/i }).first().click();
    // Open the cart sheet. The sticky bottom CTA reads "<n> items <total> → Review".
    await guest.getByRole('button', { name: /review|place order|checkout|view cart/i })
      .first().click();
    // Some businesses require Phone and/or Name on guest orders (per-business
    // setting). Fill them when present — placeholders are stable anchors.
    const phoneField = guest.getByPlaceholder('9876543210');
    if (await phoneField.isVisible().catch(() => false)) {
      await phoneField.fill('9000000001');
    }
    const nameField = guest.getByPlaceholder('Your name');
    if (await nameField.isVisible().catch(() => false)) {
      await nameField.fill('E2E Guest');
    }
    // Place the order (the cart sheet's primary CTA is "Place order · <total>")
    const placeBtn = guest.getByRole('button', { name: /place order/i }).last();
    await placeBtn.click();

    // Success state — either toast or "order placed" copy
    await expect(
      guest.getByText(/order placed|your food is on its way|tracking/i).first()
    ).toBeVisible({ timeout: 15_000 });
    await guestCtx.close();
  });
});
