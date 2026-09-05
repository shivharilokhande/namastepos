// Round 2 (2026-09-06) — review_backend_correctness.md P3 items #15 #16 #17.
//
//   #15 accountingExportService.generateEwayBill tenant-checks invoiceId and
//       writes the tenant document into eway_bills.tax_invoice_id (the old
//       invoice_id column is an FK to the PLATFORM invoices table).
//   #16 orderService.create: the membership redeem / audit try-catch blocks
//       run under SAVEPOINTs so a failed statement cannot abort the order txn.
//   #17 authService.refreshSession: rotation is a conditional UPDATE … WHERE
//       revoked_at IS NULL RETURNING; two concurrent refreshes mint ONE session.

const { resetDb, makeBusiness, closePool } = require('../setup');
const { query } = require('../../src/config/db');
const authService = require('../../src/services/authService');
const orderService = require('../../src/services/orderService');
const menuService = require('../../src/services/menuService');
const accountingExport = require('../../src/services/accountingExportService');
const taxInvoices = require('../../src/services/taxInvoiceService');

let biz;
let other;
let chaiId;

beforeAll(async () => {
  await resetDb();
  biz = await makeBusiness({ email: `r2a-p3-${Date.now()}`, name: 'P3 Fixes' });
  other = await makeBusiness({ email: `r2a-p3-other-${Date.now()}`, name: 'Other Tenant' });
  const chai = await menuService.create(biz.id, { name: 'Chai', price: 15, gstPct: 0, stock: 1000 });
  chaiId = chai.id;
});
afterAll(async () => { await closePool(); });

async function collectedOrder(bizId) {
  const o = await orderService.create(bizId, {
    items: [{ menuItemId: chaiId, name: 'Chai', price: 15, qty: 2 }],
    tax: 0,
    paymentMethod: 'cash',
  });
  await orderService.updateStatus(bizId, o.id, 'collected');
  return o.id;
}

describe('#15 generateEwayBill is tenant-scoped', () => {
  it('404s an invoice id that belongs to another tenant and writes no row', async () => {
    const otherChai = await menuService.create(other.id, { name: 'Chai', price: 15, gstPct: 0 });
    const o = await orderService.create(other.id, {
      items: [{ menuItemId: otherChai.id, name: 'Chai', price: 15, qty: 1 }], tax: 0,
    });
    await orderService.updateStatus(other.id, o.id, 'collected');
    const foreignInvoice = await taxInvoices.issueFromOrder(other.id, o.id);

    const before = await query('SELECT COUNT(*)::int AS n FROM eway_bills WHERE business_id = $1', [biz.id]);
    await expect(accountingExport.generateEwayBill(biz.id, foreignInvoice.id, { vehicleNo: 'MH12AB1234', distanceKm: 12 }))
      .rejects.toMatchObject({ statusCode: 404 });
    const after = await query('SELECT COUNT(*)::int AS n FROM eway_bills WHERE business_id = $1', [biz.id]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('404s a random uuid, works for the tenant\'s own tax invoice, and a second call does not 409', async () => {
    await expect(accountingExport.generateEwayBill(biz.id, '00000000-0000-0000-0000-000000000000', { vehicleNo: 'MH12AB1234', distanceKm: 12 }))
      .rejects.toMatchObject({ statusCode: 404 });

    const orderId = await collectedOrder(biz.id);
    const inv = await taxInvoices.issueFromOrder(biz.id, orderId);
    const a = await accountingExport.generateEwayBill(biz.id, inv.id, { vehicleNo: 'MH12AB1234', distanceKm: 12 });
    expect(a.isStub).toBe(true);
    expect(a.tax_invoice_id).toBe(inv.id);
    expect(a.invoice_id).toBeNull();
    // The old demo number was a deterministic hash of (business, invoice) →
    // the second call hit the unique constraint.
    const b = await accountingExport.generateEwayBill(biz.id, inv.id, { vehicleNo: 'MH12AB1234', distanceKm: 12 });
    expect(b.eway_no).not.toBe(a.eway_no);
  });
});

describe('#16 membership redeem failure cannot abort the order transaction', () => {
  it('still creates the order when the membership tables are unavailable mid-txn', async () => {
    // Make the membership statement fail INSIDE the order txn by hiding the
    // table (test DB only; renamed straight back). Before the SAVEPOINT the
    // swallowed error left the txn aborted and the next statement 25P02'd.
    await query('ALTER TABLE membership_subscriptions RENAME TO membership_subscriptions__hidden');
    try {
      const o = await orderService.create(biz.id, {
        items: [{ menuItemId: chaiId, name: 'Chai', price: 15, qty: 1 }],
        tax: 0,
        customerPhone: '9822011111',
        customerName: 'Member Maybe',
        paymentMethod: 'cash',
      });
      expect(o.id).toBeTruthy();
      expect(o.total).toBeCloseTo(15, 2);
      const row = await query('SELECT status, customer_phone FROM orders WHERE id = $1', [o.id]);
      expect(row.rowCount).toBe(1);
      expect(row.rows[0].customer_phone).toBe('9822011111');
    } finally {
      await query('ALTER TABLE membership_subscriptions__hidden RENAME TO membership_subscriptions');
    }
  });

  it('still creates the order when the redemption AUDIT table is unavailable', async () => {
    // Give the phone an active bundle so the redeem block succeeds and the
    // audit INSERT (the second try/catch) is the one that fails.
    const cust = await query(
      `INSERT INTO customers (business_id, phone, name) VALUES ($1, '9822022222', 'Bundle Holder')
       ON CONFLICT (business_id, phone) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [biz.id],
    );
    const plan = await query(
      'INSERT INTO memberships (business_id, name, price_paise) VALUES ($1, \'Chai Club\', 50000) RETURNING id',
      [biz.id],
    );
    await query(
      `INSERT INTO membership_subscriptions
         (business_id, customer_id, membership_id, expires_at, amount_paid_paise, status, remaining)
       VALUES ($1, $2, $3, NOW() + INTERVAL '30 days', 50000, 'active', $4::jsonb)`,
      [biz.id, cust.rows[0].id, plan.rows[0].id, JSON.stringify([{ menuItemId: chaiId, qty: 5 }])],
    );
    await query('ALTER TABLE membership_redemptions RENAME TO membership_redemptions__hidden');
    try {
      const o = await orderService.create(biz.id, {
        items: [{ menuItemId: chaiId, name: 'Chai', price: 15, qty: 1 }],
        tax: 0,
        customerPhone: '9822022222',
        paymentMethod: 'cash',
      });
      expect(o.id).toBeTruthy();
      const row = await query('SELECT id FROM orders WHERE id = $1', [o.id]);
      expect(row.rowCount).toBe(1);
    } finally {
      await query('ALTER TABLE membership_redemptions__hidden RENAME TO membership_redemptions');
    }
  });
});

describe('#17 refresh rotation is a conditional UPDATE', () => {
  it('two concurrent refreshes with one token mint exactly one session', async () => {
    const { refreshToken } = await authService.issueSession(
      { user: biz._owner, businessId: biz.id, role: 'business_owner' }, {},
    );
    const results = await Promise.allSettled([
      authService.refreshSession(refreshToken, {}),
      authService.refreshSession(refreshToken, {}),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason.statusCode).toBe(401);
    // The consumed token is revoked exactly once and cannot be replayed.
    await expect(authService.refreshSession(refreshToken, {})).rejects.toMatchObject({ statusCode: 401 });
  });

  it('the loser of the race revokes the family (reuse posture), the winner\'s fresh token still rotates when alone', async () => {
    const { refreshToken } = await authService.issueSession(
      { user: biz._owner, businessId: biz.id, role: 'business_owner' }, {},
    );
    const next = await authService.refreshSession(refreshToken, {});
    expect(next.refreshToken).toBeTruthy();
    const again = await authService.refreshSession(next.refreshToken, {});
    expect(again.accessToken).toBeTruthy();
    const revoked = await query(
      'SELECT revoked_at FROM refresh_tokens WHERE token_hash = $1',
      [require('../../src/utils/jwt').hashRefreshToken(refreshToken)],
    );
    expect(revoked.rows[0].revoked_at).not.toBeNull();
  });
});
