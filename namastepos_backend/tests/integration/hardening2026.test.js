// Regression tests for the 2026-08-30 hardening / IDOR sweep.
// Locks in: admin RBAC live-role re-check, cross-tenant variant tampering,
// cross-tenant reservation table reference, and cross-tenant tax-invoice
// idempotency leak.

const { resetDb, makeBusiness, closePool } = require('../setup');
const { query } = require('../../src/config/db');

const variantService = require('../../src/services/variantService');
const reservationService = require('../../src/services/reservationService');
const menuService = require('../../src/services/menuService');
const tableService = require('../../src/services/tableService');
const taxInvoiceService = require('../../src/services/taxInvoiceService');
const adminTeam = require('../../src/services/adminTeamService');
const adminRbac = require('../../src/middleware/adminRbac');

// Run a requirePermission middleware and capture how it settled.
function runPerm(perm, user) {
  return new Promise((resolve) => {
    const mw = adminRbac.requirePermission(perm);
    mw({ user }, {}, (err) => resolve(err ? { denied: true, err } : { denied: false }));
  });
}

let A; let
  B;
beforeAll(async () => {
  await resetDb();
  A = await makeBusiness({ email: `a-${Date.now()}` });
  B = await makeBusiness({ email: `b-${Date.now()}` });
});
afterAll(async () => { await closePool(); });

describe('Admin RBAC — live role re-check (not the stale JWT claim)', () => {
  it('denies a permission the LIVE role lacks even if the token claims super_admin', async () => {
    const email = `rbac-${Date.now()}@namastepos.in`;
    const admin = await adminTeam.create({
      email, password: 'strong-pass-123', displayName: 'RBAC Test', role: 'support',
    });
    adminRbac.invalidateRole(admin.id);
    // Token claims super_admin, but the DB says support → must be denied.
    const res = await runPerm('settings.write', { isSuperAdmin: true, id: admin.id, role: 'super_admin' });
    expect(res.denied).toBe(true);
  });

  it('reflects a live promotion once the role cache is invalidated', async () => {
    const email = `rbac2-${Date.now()}@namastepos.in`;
    const admin = await adminTeam.create({
      email, password: 'strong-pass-123', displayName: 'RBAC Test 2', role: 'support',
    });
    adminRbac.invalidateRole(admin.id);
    expect((await runPerm('settings.write', { isSuperAdmin: true, id: admin.id })).denied).toBe(true);
    await adminTeam.update(admin.id, { role: 'super_admin' }); // invalidates cache internally
    expect((await runPerm('settings.write', { isSuperAdmin: true, id: admin.id })).denied).toBe(false);
  });

  it('denies a deactivated admin all permissions', async () => {
    const email = `rbac3-${Date.now()}@namastepos.in`;
    const admin = await adminTeam.create({
      email, password: 'strong-pass-123', displayName: 'RBAC Test 3', role: 'super_admin',
    });
    await adminTeam.deactivate(admin.id);
    expect((await runPerm('customers.read', { isSuperAdmin: true, id: admin.id })).denied).toBe(true);
  });
});

describe('Cross-tenant IDOR — variants', () => {
  it("setVariants refuses an item that isn't the caller's", async () => {
    const item = await menuService.create(B.id, { name: 'B Dosa', price: 80 });
    await expect(
      variantService.setVariants(A.id, item.id, [{ label: 'Large', price: 100 }]),
    ).rejects.toThrow(/not found/i);
    // B's item still has no variants tampered in.
    const stillEmpty = await query('SELECT count(*)::int AS c FROM menu_item_variants WHERE menu_item_id = $1', [item.id]);
    expect(stillEmpty.rows[0].c).toBe(0);
  });
});

describe('Cross-tenant IDOR — reservation table reference', () => {
  it('update rejects pointing a reservation at another tenant\'s table', async () => {
    const floorB = await tableService.createFloor(B.id, { name: 'Ground' }).catch(() => null);
    const tableB = await tableService.createTable(B.id, {
      floorId: floorB?.id || null, label: 'B-T1', seats: 4,
    });
    const resA = await reservationService.create(A.id, {
      customerName: 'X',
      customerPhone: '9999999999',
      reservedAt: new Date(Date.now() + 3600e3).toISOString(),
      partySize: 2,
    });
    await expect(
      reservationService.update(A.id, resA.id, { tableId: tableB.id }),
    ).rejects.toThrow(/not found/i);
  });
});

describe('Cross-tenant IDOR — tax invoice idempotency', () => {
  it('does not return another tenant\'s invoice for their orderId', async () => {
    // Seed an order + its tax invoice for B directly.
    const ord = await query(
      `INSERT INTO orders (business_id, order_no, status, subtotal, tax, total, source)
       VALUES ($1, 9001, 'collected', 100, 5, 105, 'dineIn') RETURNING id`,
      [B.id],
    );
    const orderId = ord.rows[0].id;
    await query(
      `INSERT INTO tax_invoices
         (business_id, order_id, invoice_no, fy, fy_seq, supplier_name,
          place_of_supply, subtotal_paise, total_paise, items, status)
       VALUES ($1, $2, 'B-2026-0001', '2026-27', 1, 'B Restaurant',
               '27', 10000, 10500, '[]'::jsonb, 'issued')`,
      [B.id, orderId],
    );
    // Tenant A must NOT receive B's invoice; it should fail to find the order.
    await expect(
      taxInvoiceService.issueFromOrder(A.id, orderId),
    ).rejects.toThrow();
  });
});
