// RBAC matrix smoke — proves each role can only call routes its
// permission set allows (QA-Test foundation, addresses Vivek gap #3).
//
// We don't hit a live DB here; we exercise the `requirePermission`
// middleware directly so the matrix can run in <1s even on CI.

const { requirePermission, can } = require('../../src/middleware/adminRbac');

const ROLES = ['super_admin', 'finance', 'support', 'sales'];

const PROBES = [
  // permission, expected pass roles
  { perm: 'customers.read',      ok: ['super_admin', 'finance', 'support', 'sales'] },
  { perm: 'customers.write',     ok: ['super_admin', 'support', 'sales'] },
  { perm: 'refunds.write',       ok: ['super_admin', 'finance'] },
  { perm: 'settings.write',      ok: ['super_admin'] }, // QA-1 P0-12
  { perm: 'notes.write',         ok: ['super_admin', 'support'] },
  { perm: 'plans.change',        ok: ['super_admin', 'sales'] },
  { perm: 'gst.write',           ok: ['super_admin', 'finance'] },
  { perm: 'customers.impersonate', ok: ['super_admin', 'support'] },
];

describe('RBAC matrix', () => {
  for (const probe of PROBES) {
    for (const role of ROLES) {
      const shouldPass = probe.ok.includes(role);
      test(`${role} ${shouldPass ? 'can' : 'cannot'} ${probe.perm}`, () => {
        expect(can(role, probe.perm)).toBe(shouldPass);
      });
    }
  }

  test('non-admin requests are rejected even with a matching permission', async () => {
    const mw = requirePermission('customers.read');
    const next = jest.fn();
    await mw({ user: { isSuperAdmin: false } }, {}, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBeTruthy();
    expect(String(next.mock.calls[0][0].message)).toMatch(/admin/i);
  });
});
