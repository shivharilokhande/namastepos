// NamastePOS dashboard — pure checkout math shared by NewOrderDialog (order
// time) and TablesPage's SessionDialog (settle time).
//
// Round 3 (2026-09-06, founder Bug 1 / 1b / 2): the wallet, due and
// membership logic used to live inline in the two dialogs' render bodies,
// so nothing could assert what the request body actually carried. Every
// function here is side-effect free and unit-tested (checkout.test.ts).
//
// Money: rupees as numbers here (the API speaks `amountInr`); anything that
// must be paise-exact is rounded through `r2` (matches the server's round2).

export const r2 = (n: number) => +(Number(n) || 0).toFixed(2);

// ── Wallet ───────────────────────────────────────────────────────────────

export type WalletPlan = {
  /** What the wallet will pay: min(due, balance, cap). */
  walletInr: number;
  /** What must still be collected from another tender. */
  remainderInr: number;
  /** True when the balance alone cannot cover the due (cap ignored). */
  shortfall: boolean;
  /** balance − due when negative, else 0 — the "short by" figure. */
  shortByInr: number;
};

/**
 * Mirror of the server's autoWallet sizing (orderService / tableService):
 * wallet draw = min(due, balance, cap). `capInr` null/undefined = no cap.
 */
export function planWallet(
  dueInr: number, balanceInr: number, capInr?: number | null,
): WalletPlan {
  const due = Math.max(0, r2(dueInr));
  const bal = Math.max(0, r2(balanceInr));
  const cap = capInr == null || !Number.isFinite(Number(capInr))
    ? Infinity : Math.max(0, Number(capInr));
  const walletInr = r2(Math.min(due, bal, cap));
  const remainderInr = r2(due - walletInr);
  const shortfall = due > 0 && bal + 0.001 < due;
  return {
    walletInr,
    remainderInr,
    shortfall,
    shortByInr: shortfall ? r2(due - bal) : 0,
  };
}

export type PayLegBody = { method: string; amountInr: number };

/**
 * "Cover shortfall": wallet pays everything it has, the rest goes to the
 * chosen tender as an explicit `paymentBreakdown` (1–2 legs, both POSITIVE,
 * summing to the due within ±₹0.01 — exactly what the server's Joi wants).
 */
export function shortfallBreakdown(
  dueInr: number, balanceInr: number, method: string,
): PayLegBody[] {
  const p = planWallet(dueInr, balanceInr, null);
  const legs: PayLegBody[] = [];
  if (p.walletInr > 0) legs.push({ method: 'wallet', amountInr: p.walletInr });
  if (p.remainderInr > 0) legs.push({ method, amountInr: p.remainderInr });
  return legs;
}

// ── Order body (NewOrderDialog) ───────────────────────────────────────────

export type CartLineInput = {
  menuItemId: string;
  name: string;
  price: number;
  qty: number;
  variantId?: string | null;
  variantLabel?: string | null;
  modifierLines?: unknown[] | null;
  note?: string;
};

export type PayLegInput = { method: string; amountInr: string | number };

export type OrderBodyInput = {
  mode: 'pay' | 'kot';
  source: 'dineIn' | 'takeaway';
  tableNo: string;
  tableId: string;
  existingSessionId: string | null;
  cart: CartLineInput[];
  discount: number;
  discountIsPreTax: boolean;
  paymentMethod: 'cash' | 'upi' | 'card' | 'unpaid';
  customerPhone: string;
  customerName: string;
  /** Redeem toggle ON and the loyalty settings allow `redemptionPoints`. */
  redeemPoints: boolean;
  redemptionPoints: number | null;
  /** Manual split mode. */
  splitOn: boolean;
  legs: PayLegInput[];
  /** Wallet-as-tender toggle + availability + balance + optional cap. */
  autoWalletOn: boolean;
  walletAvailable: boolean;
  walletBalanceInr: number;
  walletCapInr: number | null;
  /** "Cover shortfall" pressed: explicit wallet + remainder legs. */
  coverShortfall: boolean;
  /** The due the shortfall legs must sum to (total − points). */
  payableTotalInr: number;
  clientId?: string;
};

export type OrderBody = {
  source: string;
  tableNo: string | null;
  tableId: string | null;
  tableSessionId: string | null;
  items: Array<{
    menuItemId: string; name: string; price: number; qty: number;
    variantId: string | null; variantLabel: string | null;
    modifierLines: unknown[] | null; note: string | null;
  }>;
  discount: number;
  discountIsPreTax: boolean;
  paymentMethod: string;
  clientId?: string;
  customerPhone?: string;
  customerName?: string;
  pointsToRedeem?: number;
  paymentBreakdown?: PayLegBody[];
  autoWallet?: boolean;
  walletCapInr?: number;
};

/**
 * The exact POST /orders body. Rules (all pre-existing, now in one place):
 *  • `tax` is never sent — the server computes GST from menu_items.gst_pct.
 *  • KOT mode is always 'unpaid' and carries no points / wallet / legs.
 *  • Points only with an identified customer (phone).
 *  • Manual split → `paymentBreakdown` from the typed legs, nothing else.
 *  • Cover-shortfall → explicit [wallet=balance, method=remainder] legs.
 *  • Otherwise, wallet toggle ON + wallet usable + balance > 0 + a real
 *    tender → `autoWallet: true` (+ `walletCapInr` when the cashier typed
 *    a cap). The server sizes the draw as min(due, balance, cap).
 */
export function buildOrderBody(i: OrderBodyInput): OrderBody {
  const isPay = i.mode === 'pay';
  const body: OrderBody = {
    source: i.source,
    tableNo: i.source === 'dineIn' ? (i.tableNo || null) : null,
    tableId: i.source === 'dineIn' ? (i.tableId || null) : null,
    tableSessionId: i.existingSessionId || null,
    items: i.cart.map((l) => ({
      menuItemId: l.menuItemId,
      name: l.name,
      price: l.price,
      qty: l.qty,
      variantId: l.variantId || null,
      variantLabel: l.variantLabel || null,
      modifierLines: l.modifierLines || null,
      note: l.note?.trim() || null,
    })),
    discount: i.discount,
    discountIsPreTax: i.discountIsPreTax,
    paymentMethod: isPay ? i.paymentMethod : 'unpaid',
  };
  if (i.clientId) body.clientId = i.clientId;
  if (i.customerPhone) {
    body.customerPhone = i.customerPhone;
    if (i.customerName) body.customerName = i.customerName;
  }
  if (!isPay) return body;

  if (i.redeemPoints && i.redemptionPoints && i.redemptionPoints > 0 && i.customerPhone) {
    body.pointsToRedeem = i.redemptionPoints;
  }

  const realTender = i.paymentMethod !== 'unpaid';
  const walletUsable = i.walletAvailable && i.walletBalanceInr > 0 && !!i.customerPhone;

  if (i.splitOn) {
    body.paymentBreakdown = i.legs.map((l) => ({
      method: l.method,
      amountInr: r2(parseFloat(String(l.amountInr)) || 0),
    }));
  } else if (i.coverShortfall && walletUsable && realTender) {
    body.paymentBreakdown = shortfallBreakdown(
      i.payableTotalInr, i.walletBalanceInr, i.paymentMethod,
    );
  } else if (i.autoWalletOn && walletUsable && realTender) {
    body.autoWallet = true;
    if (i.walletCapInr != null && Number.isFinite(i.walletCapInr) && i.walletCapInr >= 0) {
      body.walletCapInr = r2(i.walletCapInr);
    }
  }
  return body;
}

// ── Session due (settle dialog) ──────────────────────────────────────────

export type PaidLeg = { method: string; amountInr: number; orderNo?: number | string };

export type SessionDue = {
  totalInr: number;
  paidInr: number;
  dueInr: number;
  isSettled: boolean;
  paidLegs: PaidLeg[];
  /** True when the server sent the round-3 fields (not the fallback). */
  fromServer: boolean;
};

const finitePaise = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * What is still owed on a running bill.
 *
 * Prefers the round-3 contract fields (`totalPaise`, `paidPaise`,
 * `duePaise`, `isSettled`, optional `payments[]`). Falls back to
 * total − Σ(total of orders already paid at order time) — an order whose
 * `paymentMethod` is anything but 'unpaid' was collected by "Pay & place",
 * so its money must not be asked for again at settle (founder Bug 1).
 */
export function sessionDue(session: any): SessionDue {
  const orders: any[] = Array.isArray(session?.orders) ? session.orders : [];
  const live = orders.filter((o) => o?.status !== 'cancelled');
  const paidOrders = live.filter((o) => o?.paymentMethod && o.paymentMethod !== 'unpaid');

  const totalPaise = finitePaise(session?.totalPaise);
  const paidPaise = finitePaise(session?.paidPaise);
  const duePaise = finitePaise(session?.duePaise);

  // Legs actually taken. Server `payments[]` when present; otherwise one
  // synthetic leg per paid order (method + its total).
  let paidLegs: PaidLeg[] = [];
  if (Array.isArray(session?.payments) && session.payments.length > 0) {
    paidLegs = session.payments
      .map((p: any) => ({
        method: String(p.method || 'cash'),
        amountInr: p.amountPaise != null ? r2(Number(p.amountPaise) / 100) : r2(p.amountInr),
        orderNo: p.orderNo,
      }))
      .filter((p: PaidLeg) => p.amountInr > 0);
  } else {
    paidLegs = paidOrders.map((o) => ({
      method: String(o.paymentMethod),
      amountInr: r2(o.total),
      orderNo: o.orderNo,
    }));
  }

  const totalInr = totalPaise != null ? r2(totalPaise / 100) : r2(session?.totalInr);
  if (duePaise != null) {
    const dueInr = Math.max(0, r2(duePaise / 100));
    const paidInr = paidPaise != null ? r2(paidPaise / 100) : r2(totalInr - dueInr);
    const isSettled = session?.isSettled === true || (live.length > 0 && dueInr <= 0.005);
    return { totalInr, paidInr, dueInr, isSettled, paidLegs, fromServer: true };
  }
  const paidInr = r2(paidOrders.reduce((s, o) => s + (Number(o.total) || 0), 0));
  const dueInr = Math.max(0, r2(totalInr - paidInr));
  const isSettled = session?.isSettled === true || (live.length > 0 && dueInr <= 0.005);
  return { totalInr, paidInr, dueInr, isSettled, paidLegs, fromServer: false };
}

// ── Memberships ──────────────────────────────────────────────────────────

export type MembershipOption = {
  id: string;
  name: string;
  pricePaise: number;
  validityDays?: number | null;
  includes?: unknown[];
};

export type MembershipState = {
  name: string;
  exhausted: boolean;
  expired: boolean;
  /** exhausted || expired — the card should offer a renewal. */
  usedUp: boolean;
  membershipId: string | null;
  renewPricePaise: number | null;
  remaining: Array<{ menuItemId?: string; name?: string; qty: number }>;
};

/**
 * Normalise the customer lookup's `activeMembership` (round-3 shape with
 * `exhausted` / `expired` / `renewPricePaise`, or the older
 * `{ name, expires_at, remaining, benefits }` row) into one flag set.
 * `remaining: [{qty}]` all ≤ 0 counts as exhausted when the server did not
 * say so explicitly; a benefit-only membership (no bundle) never does.
 */
export function membershipState(am: any, now: number = Date.now()): MembershipState | null {
  if (!am) return null;
  const remaining: Array<{ menuItemId?: string; name?: string; qty: number }> =
    Array.isArray(am.remaining)
      ? am.remaining.map((r: any) => ({
        menuItemId: r.menuItemId ?? r.menu_item_id,
        name: r.name,
        qty: Number(r.qty ?? r.remaining ?? 0) || 0,
      }))
      : [];
  const exhausted = am.exhausted === true
    || (am.exhausted !== false && remaining.length > 0 && remaining.every((r) => r.qty <= 0));
  const expiresAt = am.expiresAt ?? am.expires_at ?? null;
  const expiresMs = expiresAt ? Date.parse(expiresAt) : NaN;
  const expired = am.expired === true
    || (am.expired !== false && Number.isFinite(expiresMs) && expiresMs <= now);
  const renew = am.renewPricePaise ?? am.price_paise ?? am.pricePaise ?? null;
  return {
    name: String(am.name || 'Membership'),
    exhausted,
    expired,
    usedUp: exhausted || expired,
    membershipId: am.membershipId ?? am.membership_id ?? null,
    renewPricePaise: renew == null ? null : Number(renew),
    remaining,
  };
}

/**
 * Purchasable plans for the offer / renew card. Prefers the lookup's
 * `availableMemberships`; falls back to the raw /memberships list rows
 * (snake_case, `is_active`, `price_paise`). Free (₹0) plans are skipped —
 * nothing to sell.
 */
export function membershipOptions(
  available: any[] | null | undefined, rawPlans: any[] | null | undefined,
): MembershipOption[] {
  const src = Array.isArray(available) && available.length > 0 ? available : (rawPlans || []);
  return src
    .filter((m: any) => m && m.is_active !== false && m.isActive !== false)
    .map((m: any) => ({
      id: String(m.id),
      name: String(m.name || 'Membership'),
      pricePaise: Number(m.pricePaise ?? m.price_paise ?? 0) || 0,
      validityDays: m.validityDays ?? m.validity_days ?? null,
      includes: Array.isArray(m.includes) ? m.includes : undefined,
    }))
    .filter((m) => m.pricePaise > 0);
}
