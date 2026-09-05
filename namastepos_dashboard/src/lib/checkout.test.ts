import { describe, it, expect } from 'vitest';
import {
  buildOrderBody, planWallet, shortfallBreakdown, sessionDue,
  membershipState, membershipOptions, type OrderBodyInput,
} from './checkout';

// Founder's round-3 flow (2026-09-06): Pav Bhaji ₹120, 36 points redeemed
// → ₹84 due, wallet ₹135.37 with the toggle ON.
const base: OrderBodyInput = {
  mode: 'pay',
  source: 'dineIn',
  tableNo: 'T1',
  tableId: 'tbl-1',
  existingSessionId: null,
  cart: [{ menuItemId: 'mi-1', name: 'Amul Pav Bhaji', price: 120, qty: 1, note: '  ' }],
  discount: 0,
  discountIsPreTax: true,
  paymentMethod: 'cash',
  customerPhone: '9876543210',
  customerName: 'Shiv',
  redeemPoints: true,
  redemptionPoints: 36,
  splitOn: false,
  legs: [],
  autoWalletOn: true,
  walletAvailable: true,
  walletBalanceInr: 135.37,
  walletCapInr: null,
  coverShortfall: false,
  payableTotalInr: 84,
  clientId: 'uuid-1',
};

describe('buildOrderBody — wallet toggle → request body (Bug 1)', () => {
  it('sends autoWallet:true + pointsToRedeem when the toggle is on', () => {
    const b = buildOrderBody(base);
    expect(b.autoWallet).toBe(true);
    expect(b.walletCapInr).toBeUndefined();
    expect(b.pointsToRedeem).toBe(36);
    expect(b.paymentMethod).toBe('cash');
    expect(b.paymentBreakdown).toBeUndefined();
    expect(b.customerPhone).toBe('9876543210');
    expect(b.customerName).toBe('Shiv');
    expect(b.clientId).toBe('uuid-1');
    // GST is the server's job — never in the body
    expect('tax' in b).toBe(false);
    // blank note → null
    expect(b.items[0].note).toBeNull();
  });

  it('forwards the cashier cap as walletCapInr', () => {
    const b = buildOrderBody({ ...base, walletCapInr: 50 });
    expect(b.autoWallet).toBe(true);
    expect(b.walletCapInr).toBe(50);
  });

  it('does NOT send autoWallet when the toggle is off', () => {
    const b = buildOrderBody({ ...base, autoWalletOn: false });
    expect(b.autoWallet).toBeUndefined();
    expect(b.walletCapInr).toBeUndefined();
  });

  it('does NOT send autoWallet without a usable wallet / zero balance / unpaid', () => {
    expect(buildOrderBody({ ...base, walletAvailable: false }).autoWallet).toBeUndefined();
    expect(buildOrderBody({ ...base, walletBalanceInr: 0 }).autoWallet).toBeUndefined();
    expect(buildOrderBody({ ...base, paymentMethod: 'unpaid' }).autoWallet).toBeUndefined();
    expect(buildOrderBody({ ...base, customerPhone: '' }).autoWallet).toBeUndefined();
  });

  it('KOT mode is unpaid and carries no points, wallet or legs', () => {
    const b = buildOrderBody({ ...base, mode: 'kot', splitOn: true, legs: [{ method: 'cash', amountInr: '84' }] });
    expect(b.paymentMethod).toBe('unpaid');
    expect(b.pointsToRedeem).toBeUndefined();
    expect(b.autoWallet).toBeUndefined();
    expect(b.paymentBreakdown).toBeUndefined();
  });

  it('manual split wins over autoWallet and rounds legs to paise', () => {
    const b = buildOrderBody({
      ...base, splitOn: true,
      legs: [{ method: 'wallet', amountInr: '50.005' }, { method: 'upi', amountInr: '34' }],
    });
    expect(b.autoWallet).toBeUndefined();
    expect(b.paymentBreakdown).toEqual([
      { method: 'wallet', amountInr: 50.01 }, { method: 'upi', amountInr: 34 },
    ]);
  });

  it('cover-shortfall sends explicit wallet + remainder legs summing to the due (Bug 1b)', () => {
    const b = buildOrderBody({
      ...base, coverShortfall: true, walletBalanceInr: 50, payableTotalInr: 84, paymentMethod: 'upi',
    });
    expect(b.autoWallet).toBeUndefined();
    expect(b.paymentBreakdown).toEqual([
      { method: 'wallet', amountInr: 50 }, { method: 'upi', amountInr: 34 },
    ]);
    const sum = b.paymentBreakdown!.reduce((s, l) => s + l.amountInr, 0);
    expect(+sum.toFixed(2)).toBe(84);
  });

  it('points are skipped without a customer phone', () => {
    const b = buildOrderBody({ ...base, customerPhone: '' });
    expect(b.pointsToRedeem).toBeUndefined();
    expect(b.customerPhone).toBeUndefined();
  });

  it('takeaway drops table fields', () => {
    const b = buildOrderBody({ ...base, source: 'takeaway' });
    expect(b.tableId).toBeNull();
    expect(b.tableNo).toBeNull();
  });
});

describe('planWallet — displayed due = total − points − wallet', () => {
  it('wallet covers the whole due when the balance is enough', () => {
    const p = planWallet(84, 135.37);
    expect(p.walletInr).toBe(84);
    expect(p.remainderInr).toBe(0);
    expect(p.shortfall).toBe(false);
    expect(p.shortByInr).toBe(0);
  });

  it('flags a shortfall and the remainder when the balance is short', () => {
    const p = planWallet(200, 135.37);
    expect(p.walletInr).toBe(135.37);
    expect(p.remainderInr).toBe(64.63);
    expect(p.shortfall).toBe(true);
    expect(p.shortByInr).toBe(64.63);
  });

  it('honours the cashier cap without calling it a shortfall', () => {
    const p = planWallet(84, 135.37, 50);
    expect(p.walletInr).toBe(50);
    expect(p.remainderInr).toBe(34);
    expect(p.shortfall).toBe(false);
  });

  it('zero due → nothing from the wallet', () => {
    const p = planWallet(0, 135.37);
    expect(p.walletInr).toBe(0);
    expect(p.shortfall).toBe(false);
  });
});

describe('shortfallBreakdown', () => {
  it('drops the remainder leg when the wallet covers everything', () => {
    expect(shortfallBreakdown(84, 135.37, 'cash')).toEqual([{ method: 'wallet', amountInr: 84 }]);
  });
  it('drops the wallet leg when the balance is zero', () => {
    expect(shortfallBreakdown(84, 0, 'card')).toEqual([{ method: 'card', amountInr: 84 }]);
  });
});

describe('sessionDue — settle shows Paid when the bill was collected at order time', () => {
  const orders = [
    { id: 'o1', orderNo: 11, total: 84, status: 'collected', paymentMethod: 'wallet' },
    { id: 'o2', orderNo: 12, total: 50, status: 'preparing', paymentMethod: 'unpaid' },
    { id: 'o3', orderNo: 13, total: 999, status: 'cancelled', paymentMethod: 'unpaid' },
  ];

  it('uses the round-3 server fields when present', () => {
    const d = sessionDue({
      totalInr: 134, totalPaise: 13400, paidPaise: 8400, duePaise: 5000, isSettled: false,
      orders,
      payments: [{ method: 'wallet', amountPaise: 8400, orderNo: 11 }],
    });
    expect(d.fromServer).toBe(true);
    expect(d.totalInr).toBe(134);
    expect(d.paidInr).toBe(84);
    expect(d.dueInr).toBe(50);
    expect(d.isSettled).toBe(false);
    expect(d.paidLegs).toEqual([{ method: 'wallet', amountInr: 84, orderNo: 11 }]);
  });

  it('server isSettled / duePaise 0 → Paid', () => {
    const d = sessionDue({ totalInr: 84, duePaise: 0, paidPaise: 8400, isSettled: true, orders: [orders[0]] });
    expect(d.isSettled).toBe(true);
    expect(d.dueInr).toBe(0);
  });

  it('falls back to total − Σ(paid orders) when the fields are absent', () => {
    const d = sessionDue({ totalInr: 134, orders });
    expect(d.fromServer).toBe(false);
    expect(d.paidInr).toBe(84);
    expect(d.dueInr).toBe(50);
    expect(d.isSettled).toBe(false);
    expect(d.paidLegs).toEqual([{ method: 'wallet', amountInr: 84, orderNo: 11 }]);
  });

  it('fallback: every live order paid at Pay & place → due 0, settled', () => {
    const d = sessionDue({ totalInr: 84, orders: [orders[0], orders[2]] });
    expect(d.dueInr).toBe(0);
    expect(d.isSettled).toBe(true);
  });

  it('fallback: nothing paid → due = total, not settled; no orders → not settled', () => {
    expect(sessionDue({ totalInr: 50, orders: [orders[1]] })).toMatchObject({ dueInr: 50, isSettled: false });
    expect(sessionDue({ totalInr: 0, orders: [] })).toMatchObject({ dueInr: 0, isSettled: false });
  });
});

describe('membershipState — exhausted / expired detection (Bug 2)', () => {
  it('reads the round-3 flags verbatim', () => {
    const s = membershipState({
      id: 'sub1', membershipId: 'm1', name: 'Coffee 10', exhausted: true, expired: false,
      remaining: [{ menuItemId: 'mi', name: 'Cold coffee', qty: 0 }], renewPricePaise: 49900,
    })!;
    expect(s.usedUp).toBe(true);
    expect(s.exhausted).toBe(true);
    expect(s.expired).toBe(false);
    expect(s.renewPricePaise).toBe(49900);
    expect(s.membershipId).toBe('m1');
  });

  it('derives exhaustion from an all-zero bundle on the legacy row', () => {
    const s = membershipState({
      name: 'Coffee 10', expires_at: '2999-01-01T00:00:00Z',
      remaining: [{ menu_item_id: 'mi', name: 'Cold coffee', qty: 0 }], benefits: {},
    })!;
    expect(s.exhausted).toBe(true);
    expect(s.expired).toBe(false);
    expect(s.usedUp).toBe(true);
  });

  it('a benefit-only membership (no bundle) with units left is NOT used up', () => {
    const s = membershipState({ name: 'Gold 10%', expires_at: '2999-01-01T00:00:00Z', remaining: [], benefits: { discount_pct: 10 } })!;
    expect(s.usedUp).toBe(false);
    const t = membershipState({ name: 'Coffee 10', remaining: [{ qty: 3 }], expiresAt: '2999-01-01T00:00:00Z' })!;
    expect(t.usedUp).toBe(false);
  });

  it('derives expiry from expiresAt', () => {
    const s = membershipState({ name: 'X', expiresAt: '2020-01-01T00:00:00Z', remaining: [{ qty: 5 }] }, Date.parse('2026-09-06T00:00:00Z'))!;
    expect(s.expired).toBe(true);
    expect(s.usedUp).toBe(true);
  });

  it('null in → null out', () => {
    expect(membershipState(null)).toBeNull();
  });
});

describe('membershipOptions', () => {
  it('prefers availableMemberships (camelCase) and drops free plans', () => {
    const o = membershipOptions(
      [{ id: 'a', name: 'A', pricePaise: 10000, validityDays: 30, includes: [] }, { id: 'f', name: 'Free', pricePaise: 0 }],
      [{ id: 'z', name: 'Raw', price_paise: 500 }],
    );
    expect(o.map((m) => m.id)).toEqual(['a']);
    expect(o[0].validityDays).toBe(30);
  });
  it('falls back to raw /memberships rows and skips inactive', () => {
    const o = membershipOptions(null, [
      { id: 'z', name: 'Raw', price_paise: '500', validity_days: 90, is_active: true },
      { id: 'i', name: 'Inactive', price_paise: 900, is_active: false },
    ]);
    expect(o).toEqual([{ id: 'z', name: 'Raw', pricePaise: 500, validityDays: 90, includes: undefined }]);
  });
});
