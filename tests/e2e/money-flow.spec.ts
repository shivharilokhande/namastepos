// CI E2E — the one flow whose breakage is unrecoverable.
//
//   owner logs in → takes an order in the POS → the order shows the correct
//   SERVER-COMPUTED total → the order is settled → the day's revenue reflects it
//
// Everything else in the product can be worked around for an afternoon. If the
// POS charges the wrong number, the restaurant has already taken the customer's
// money and there is nothing to roll back — so this path gets a permanent gate.
//
// Design notes that keep this non-flaky:
//   • Each test seeds its OWN tenant (unique email + business). Nothing here
//     reads data another spec created, so order/parallelism can't matter.
//   • The seeded item is ₹100 at gstPct 0, so the expected total is an exact
//     constant (₹200 for qty 2) rather than a function of the tenant's
//     round-off / service-charge / discount-is-pre-tax settings.
//   • No waitForTimeout anywhere. Web-first assertions plus explicit
//     waitForResponse on the mutations we care about.
//   • No page.reload() — see the note in fixtures/dashboard.ts about the
//     in-memory access token.

import { test, expect } from '@playwright/test';
import {
  makeBusiness, addMenuItem, markOnboarded, getOrder, dailyReport,
  type SeededBusiness, type SeededMenuItem,
} from './fixtures/seed';
import { loginAsOwner, navigate, rx } from './fixtures/dashboard';

const UNIT_PRICE = 100;
const QTY = 2;
const EXPECTED_TOTAL = UNIT_PRICE * QTY; // 200 — zero-rated, so no GST term.

let biz: SeededBusiness;
let item: SeededMenuItem;

test.beforeEach(async () => {
  biz = await makeBusiness();
  item = await addMenuItem(biz, { price: UNIT_PRICE, gstPct: 0 });
  await markOnboarded(biz);
});

test.afterEach(async () => {
  await biz.api.dispose();
});

test('owner takes an order, it prices correctly, settles, and lands in today\'s revenue', async ({ page }) => {
  await loginAsOwner(page, biz);

  // Revenue starts at zero for a tenant created seconds ago. Asserted so a
  // later "revenue == 200" cannot pass on pre-existing data.
  const before = await dailyReport(biz);
  expect(before?.revenue?.total ?? 0).toBe(0);

  await navigate(page, 'Orders');
  await expect(page.getByRole('heading', { name: 'Live orders', level: 1 })).toBeVisible();

  // ── Take the order ────────────────────────────────────────────────────────
  await page.getByRole('button', { name: /Take order/ }).click();

  const itemTile = page.getByRole('button', { name: rx(item.name) });
  await expect(itemTile).toBeVisible();
  // Two clicks = qty 2 (addItem increments an existing line).
  await itemTile.click();
  await itemTile.click();

  // The CTA carries the running total the cashier is about to charge. This is
  // the client's arithmetic — asserted because it is what the human reads
  // aloud, and it must agree with the server figure checked below.
  const payButton = page.getByRole('button', { name: /Pay & place/ });
  await expect(payButton).toHaveText(new RegExp(`Pay & place\\s*—\\s*₹\\s*${EXPECTED_TOTAL}\\b`));

  const [createRes] = await Promise.all([
    page.waitForResponse(
      (r) => /\/orders$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST',
    ),
    payButton.click(),
  ]);
  expect(createRes.status(), 'order create should succeed').toBe(201);
  const created = await createRes.json();
  const orderId: string = created?.id ?? created?.order?.id;
  expect(orderId, 'order create response carried no id').toBeTruthy();

  // ── The order appears with the correct server-computed total ─────────────
  // The dialog closes and the Pending tab re-queries.
  await expect(page.getByRole('button', { name: /Pay & place/ })).toBeHidden();

  const card = page.locator('.rounded-lg', { hasText: rx(item.name) }).first();
  await expect(page.getByText(`${QTY} × ${item.name}`)).toBeVisible();
  await expect(card.getByText(`₹${EXPECTED_TOTAL}`).first()).toBeVisible();

  // THE assertion this whole spec exists for: the number the SERVER persisted.
  // orderController prices every line from menu_items.price and treats the
  // client's `price` as advisory only (NP-201/NP-202), so this is the guard on
  // that contract. A regression that starts trusting the client, double-applies
  // GST, or drops a line item breaks here.
  const serverOrder = await getOrder(biz, orderId);
  expect(Number(serverOrder.total)).toBe(EXPECTED_TOTAL);
  expect(Number(serverOrder.subtotal)).toBe(EXPECTED_TOTAL);
  expect(Number(serverOrder.tax)).toBe(0);
  expect(serverOrder.status).toBe('pending');

  // ── Settle it: pending → ready → collected ──────────────────────────────
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes(`/orders/${orderId}/status`) && r.request().method() === 'PUT',
    ),
    page.getByRole('button', { name: 'Mark ready' }).click(),
  ]);

  await page.getByRole('button', { name: 'Ready', exact: true }).click();
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes(`/orders/${orderId}/status`) && r.request().method() === 'PUT',
    ),
    page.getByRole('button', { name: 'Mark collected' }).click(),
  ]);

  await page.getByRole('button', { name: 'Collected', exact: true }).click();
  await expect(page.getByText(`${QTY} × ${item.name}`)).toBeVisible();

  const settled = await getOrder(biz, orderId);
  expect(settled.status).toBe('collected');
  // Settling must not restate the money.
  expect(Number(settled.total)).toBe(EXPECTED_TOTAL);

  // ── The day's revenue reflects it ───────────────────────────────────────
  // reportService.dailyReport bypasses its own report_cache row for today
  // (`if (cached && !isToday(dateStr))`), so this read is always fresh.
  const after = await dailyReport(biz);
  expect(after?.revenue?.total).toBe(EXPECTED_TOTAL);
  expect(after?.orderCount).toBe(1);

  // And the Overview KPI the owner actually looks at. ₹200 exactly — a
  // double-count regression would read ₹400 and fail here.
  await navigate(page, 'Overview');
  await expect(page.getByRole('heading', { name: 'Today', level: 1 })).toBeVisible();
  await expect(page.getByText('Revenue')).toBeVisible();
  await expect(page.getByText(`₹${EXPECTED_TOTAL}`).first()).toBeVisible();
});

test('the server prices from the menu and ignores a client-supplied price', async () => {
  // Same money boundary as above, driven straight at the API so it stays fast
  // and cannot be broken by UI churn. A POS running a stale offline menu (or a
  // tampered client) sends its own `price`; the server must charge its own.
  const res = await biz.api.post(`/businesses/${biz.businessId}/orders`, {
    data: {
      source: 'takeaway',
      paymentMethod: 'cash',
      items: [{
        menuItemId: item.id,
        name: item.name,
        price: 1, // a lie: the real menu price is ₹100
        qty: QTY,
      }],
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const order = await res.json();

  expect(Number(order.total)).toBe(EXPECTED_TOTAL);
  expect(Number(order.total)).not.toBe(QTY * 1);
});
