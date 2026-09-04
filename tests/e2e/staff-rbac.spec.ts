// CI E2E — staff RBAC. Permanent guard for the "kitchen staff saw owner UI"
// class of bug.
//
// A `staff_kitchen` member's permission set is exactly ['home', 'kds']
// (staffService.DEFAULT_PERMS_BY_ROLE). They must not be able to read the
// team roster, the P&L, or the day's takings.
//
// ─────────────────────────────────────────────────────────────────────────────
// READ THIS BEFORE TRUSTING THIS FILE
//
// While writing these tests I found the fix is only HALF shipped:
//
//   • backend  — FIXED. requireStaffPerm / requireRole gate the routes, so no
//                tenant DATA leaks to a kitchen login. Covered live below.
//   • Flutter  — FIXED. home_bottom_nav.dart calls
//                RolePerms.visibleTabs(auth.role, permissions: auth.permissions).
//   • web dashboard — NOT FIXED. namastepos_dashboard/src/components/Layout.tsx
//                builds the sidebar from navTop/navGroups/navBottom and gates
//                each entry ONLY on plan.has(feature) and addons.has(addon).
//                There is no role or permission check anywhere in that file, so
//                a kitchen staffer signed into the WEB dashboard still sees
//                Staff, Settings, Reports, Accounting and Plans & Billing.
//                Clicking one 403s, so it is a UI-integrity bug rather than a
//                data leak — but it is the same bug that was reported.
//
// So the nav test at the bottom is marked test.fixme(): it is written to assert
// the CORRECT behaviour and it FAILS against main today. Deleting the
// `.fixme` turns it into the permanent guard the moment Layout.tsx learns about
// roles. It is quarantined rather than deleted so the gap stays visible in the
// suite instead of living only in a report.
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect } from '@playwright/test';
import {
  makeBusiness, addMenuItem, markOnboarded, addPinStaff, pinLoginContext, todayIso,
  type SeededBusiness, type SeededStaff,
} from './fixtures/seed';
import { loginAsPinStaff } from './fixtures/dashboard';

let biz: SeededBusiness;
let kitchen: SeededStaff;

test.beforeEach(async () => {
  biz = await makeBusiness();
  // A menu item + onboarded flag so the app is in a normal steady state
  // rather than the first-run wizard.
  await addMenuItem(biz);
  await markOnboarded(biz);
  kitchen = await addPinStaff(biz, { role: 'staff_kitchen', displayName: 'E2E Cook' });
});

test.afterEach(async () => {
  await biz.api.dispose();
});

test('a kitchen login is refused the team roster and the money reports', async () => {
  const cook = await pinLoginContext(kitchen);

  try {
    // The session must describe the cook honestly — this is the input the
    // clients are supposed to gate on.
    const me = await cook.get('/auth/me');
    expect(me.ok()).toBeTruthy();
    const meBody = await me.json();
    expect(meBody.role).toBe('staff_kitchen');
    expect(meBody.permissions).toEqual(expect.arrayContaining(['home', 'kds']));
    expect(meBody.permissions).not.toContain('reports');
    expect(meBody.permissions).not.toContain('pnl_statement');

    // Team roster — requireRole(['business_owner', 'staff_manager']).
    const roster = await cook.get(`/businesses/${biz.businessId}/staff`);
    expect(roster.status(), 'a cook must not enumerate the team').toBe(403);

    // Today's takings — requireStaffPerm('reports').
    const daily = await cook.get(`/businesses/${biz.businessId}/reports/daily`, {
      params: { date: todayIso() },
    });
    expect(daily.status(), 'a cook must not read the day\'s revenue').toBe(403);

    // P&L — requireStaffPerm('pnl_statement').
    const pnl = await cook.get(`/businesses/${biz.businessId}/reports/income-statement`, {
      params: { from: todayIso(), to: todayIso() },
    });
    expect(pnl.status(), 'a cook must not read the P&L').toBe(403);
  } finally {
    await cook.dispose();
  }

  // Not vacuous: the SAME three routes answer the owner. Without this, a
  // change that 403s everyone (a broken route mount, a bad businessId) would
  // leave the assertions above passing for the wrong reason.
  const roster = await biz.api.get(`/businesses/${biz.businessId}/staff`);
  expect(roster.ok(), 'owner must still see the roster').toBeTruthy();
  const daily = await biz.api.get(`/businesses/${biz.businessId}/reports/daily`, {
    params: { date: todayIso() },
  });
  expect(daily.ok(), 'owner must still see the daily report').toBeTruthy();
});

test('a kitchen staffer can sign in to the dashboard with phone + PIN', async ({ page }) => {
  // Sanity + the precondition for the nav test below. If phone+PIN sign-in
  // breaks, the nav assertion would "pass" for the wrong reason.
  await loginAsPinStaff(page, kitchen);
  await expect(page.locator('aside')).toBeVisible();
});

// eslint-disable-next-line playwright/no-skipped-test
test.fixme('a kitchen login does not see owner-only navigation', async ({ page }) => {
  // FAILS ON MAIN TODAY — see the header comment. The fix is to gate
  // renderNavItem() in namastepos_dashboard/src/components/Layout.tsx on the
  // session's `permissions` (the same keyspace Flutter's RolePerms uses), not
  // just on plan features. Remove `.fixme` in the same commit as that change.
  await loginAsPinStaff(page, kitchen);

  const sidebar = page.locator('aside');
  await expect(sidebar).toBeVisible();

  // What a cook legitimately needs.
  await expect(sidebar.getByRole('link', { name: 'KDS', exact: true })).toBeVisible();

  // What a cook must never be offered.
  for (const ownerOnly of ['Staff', 'Settings', 'Reports', 'Accounting', 'Plans & Billing']) {
    await expect(
      sidebar.getByRole('link', { name: ownerOnly, exact: true }),
      `"${ownerOnly}" must be hidden from a staff_kitchen session`,
    ).toHaveCount(0);
  }
});
