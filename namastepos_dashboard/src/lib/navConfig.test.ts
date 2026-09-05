import { describe, it, expect } from 'vitest';
import { allNavItems, canSeeNavItem, featureForRoute, navGroups } from './navConfig';

const byPath = (to: string) => {
  const it = allNavItems.find((i) => i.to === to);
  if (!it) throw new Error(`no nav item ${to}`);
  return it;
};

describe('canSeeNavItem — D-09 staff filtering', () => {
  // A kitchen staffer's effective permission list from /auth/me (mirrors
  // staffService.DEFAULT_PERMS_BY_ROLE for staff_kitchen).
  const KITCHEN_PERMS = ['home', 'kds'];

  it('owner sees everything, including owner-only items', () => {
    for (const item of allNavItems) {
      expect(canSeeNavItem(item, 'business_owner', null)).toBe(true);
    }
  });

  it('kitchen staff sees only Overview / KDS / KOT and the perm:null items', () => {
    const visible = allNavItems.filter((i) => canSeeNavItem(i, 'staff_kitchen', KITCHEN_PERMS)).map((i) => i.to).sort();
    expect(visible).toEqual(['/', '/action-center', '/help', '/kds', '/kot', '/privacy', '/support'].sort());
  });

  it('kitchen staff never sees Billing, Staff, Settings, Reports or Orders', () => {
    for (const to of ['/billing', '/staff', '/settings', '/reports', '/orders', '/expenses', '/recurring-invoices', '/b2b-invoice-template']) {
      expect(canSeeNavItem(byPath(to), 'staff_kitchen', KITCHEN_PERMS)).toBe(false);
    }
  });

  it('is least-privilege while role/permissions are unknown', () => {
    expect(canSeeNavItem(byPath('/orders'), null, null)).toBe(false);
    expect(canSeeNavItem(byPath('/orders'), 'staff_cashier', null)).toBe(false);
    // …but perm:null items (Privacy, Help, Support) are always visible.
    expect(canSeeNavItem(byPath('/privacy'), null, null)).toBe(true);
  });
});

describe('featureForRoute — route guard reads the same table as the nav', () => {
  it('D-13: /inventory is gated on inventory_tracking (web aligned to mobile)', () => {
    expect(featureForRoute('/inventory')).toBe('inventory_tracking');
    expect(byPath('/inventory').feature).toBe('inventory_tracking');
  });

  it('round-2 built features are gated on their own keys', () => {
    expect(featureForRoute('/b2b-invoice-template')).toBe('b2b_invoice');
    expect(featureForRoute('/recurring-invoices')).toBe('recurring_invoices');
  });

  it('always-on routes and add-on-capable routes return null', () => {
    expect(featureForRoute('/settings')).toBeNull();
    expect(featureForRoute('/billing')).toBeNull();
    // /customers can also be unlocked by the loyalty add-on → page handles its own 402.
    expect(featureForRoute('/customers')).toBeNull();
    expect(featureForRoute('/does-not-exist')).toBeNull();
  });

  it('every nav item has a unique path and a perm declaration', () => {
    const paths = allNavItems.map((i) => i.to);
    expect(new Set(paths).size).toBe(paths.length);
    for (const i of allNavItems) expect(i.perm === null || typeof i.perm === 'string').toBe(true);
    expect(navGroups.length).toBeGreaterThan(0);
  });
});
