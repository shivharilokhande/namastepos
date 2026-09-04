// NamastePOS dashboard — the seven activation-funnel events.
//
// This is the *composition* layer over lib/analytics.ts: it knows what a
// "menu_ready" or a "first_bill" means in NamastePOS terms, so pages don't.
// It never touches gtag — every emit goes through analytics.track/trackOnce,
// which owns the allow-list, the PII scrub, the consent gate and the
// no-op-when-unconfigured guard.
//
// Dependency direction (no cycles):
//   pages ─▶ lib/activation ─▶ lib/analytics
//   pages ─▶ api/namastepos ─▶ api/client ─▶ lib/analytics
// lib/analytics imports nothing from the app, which is what lets
// api/client.ts emit `plan_limit_hit` from its own error interceptor.

import { ffApi } from '@/api/namastepos';
import {
  track, trackOnce, hasFired, lastBlockedMetric, analyticsEnabled,
  minutesSinceSignup, daysSinceSignup, withinFirst24h,
} from '@/lib/analytics';

/**
 * Nothing in this file may do work when analytics is unconfigured — two of
 * these events need a small API read to fill a property, and an
 * unconfigured dashboard must not pay for a request nobody will ever look
 * at. `analytics.track()` is already a no-op; this guard covers the work
 * AROUND the emit.
 */
function off(): boolean { return !analyticsEnabled(); }

// ── "Owner-authored" ─────────────────────────────────────────────────────
//
// The activation metric deliberately excludes the rows the product filled
// in for the owner, so clicking through the setup wizard cannot fake an
// activation. Two sources of pre-filled rows exist today:
//   • SetupWizardPage step 3  — Masala Chai 30 / Butter Naan 40 /
//     Paneer Tikka 250
//   • MenuCsvImportDialog's downloadable SAMPLE_CSV
// A row counts as pre-filled only when BOTH the name and the price still
// match the default exactly; edit either one and it is the owner's.

const PREFILLED: ReadonlyArray<{ name: string; price: number }> = [
  { name: 'masala chai', price: 30 },
  { name: 'butter naan', price: 40 },
  { name: 'paneer tikka', price: 250 },
  // MenuCsvImportDialog SAMPLE_CSV rows
  { name: 'paneer butter masala', price: 280 },
  { name: 'chicken 65', price: 240 },
];

export interface MenuItemLike {
  name?: string | null;
  price?: number | string | null;
  isActive?: boolean;
}

function isPrefilled(name: unknown, price: unknown): boolean {
  const n = String(name ?? '').trim().toLowerCase();
  const p = Number(price);
  return PREFILLED.some((d) => d.name === n && d.price === p);
}

/** Active menu items the owner actually authored or imported. */
export function countOwnerAuthored(items: MenuItemLike[]): number {
  if (!Array.isArray(items)) return 0;
  return items.filter(
    (it) => it && it.isActive !== false && !isPrefilled(it.name, it.price),
  ).length;
}

/** True when at least one billed line is not an untouched pre-fill. */
export function hasOwnerAuthoredLine(
  lines: Array<{ name?: string | null; price?: number | string | null }>,
): boolean {
  if (!Array.isArray(lines) || lines.length === 0) return false;
  return lines.some((l) => l && !isPrefilled(l.name, l.price));
}

// ── 1. signup ────────────────────────────────────────────────────────────

/** POST /auth/register or Google sign-up returned 200/201. */
export function trackSignup(opts: {
  method: 'email' | 'google';
  hasBusinessName: boolean;
  referralCode?: string | null;
}) {
  track('signup', {
    method: opts.method,
    has_business_name: opts.hasBusinessName,
    // An opaque referral code, not a person. Kept because attribution is
    // the whole point of the referral programme.
    referral_code: opts.referralCode || '',
  });
}

// ── 2. business_created ──────────────────────────────────────────────────

/**
 * Fired once, the first time a business.id lands in the session. Separate
 * from `signup` because Google sign-in is find-or-create and may hand back
 * a business that already existed.
 */
export function trackBusinessCreated(opts: {
  isNew: boolean;
  category?: string | null;
}) {
  trackOnce('business_created', {
    is_new: opts.isNew,
    // Business category (Café / QSR / Cloud kitchen …) — a segment, not an
    // identifier. Null until the wizard sets it.
    category: opts.category || null,
  });
}

// ── 3. menu_ready ────────────────────────────────────────────────────────

export type MenuReadySource = 'wizard' | 'manual' | 'bulk_csv' | 'migrate';

const MENU_READY_THRESHOLD = 3;

// Remembered so the one extra GET below happens at most once per page load.
let cachedMenuCap: number | null | undefined;

async function menuItemCap(): Promise<number | null> {
  if (cachedMenuCap !== undefined) return cachedMenuCap;
  try {
    const sub = await ffApi.subscription();
    const raw = sub?.plan?.limits?.menu_items;
    cachedMenuCap = typeof raw === 'number' ? raw : null;
  } catch {
    cachedMenuCap = null;
  }
  return cachedMenuCap;
}

/**
 * Crossing >= 3 owner-authored ACTIVE menu items for the first time.
 *
 * Call it with whatever menu list the caller already has — it exits before
 * doing any work if the milestone has already fired or the threshold is not
 * met, so it is cheap to call on every menu refetch.
 */
export async function trackMenuReady(
  items: MenuItemLike[],
  source: MenuReadySource,
): Promise<void> {
  if (off() || hasFired('menu_ready')) return;
  const count = countOwnerAuthored(items);
  if (count < MENU_READY_THRESHOLD) return;
  // Only now is the extra subscription read worth it: this runs at most
  // once per business, on the render that crosses the threshold.
  const cap = await menuItemCap();
  if (hasFired('menu_ready')) return; // lost a race with another caller
  trackOnce('menu_ready', {
    item_count: count,
    source,
    minutes_since_signup: minutesSinceSignup(),
    // The pricing cliff, as a boolean: an owner already over their plan's
    // menu cap the moment their menu is usable.
    over_plan_cap: cap !== null && cap !== -1 && count > cap,
  });
}

/** Fire-and-forget wrapper for call sites that are not async. */
export function trackMenuReadyAsync(items: MenuItemLike[], source: MenuReadySource) {
  void trackMenuReady(items, source).catch(() => { /* analytics never throws upward */ });
}

/** Same, but reads the current menu from the API first (post-import paths). */
export function trackMenuReadyFromServer(source: MenuReadySource) {
  if (off() || hasFired('menu_ready')) return;
  void (async () => {
    try {
      const items = await ffApi.listMenu();
      await trackMenuReady(items as MenuItemLike[], source);
    } catch { /* never surface an analytics failure */ }
  })();
}

// ── 4. first_kot ─────────────────────────────────────────────────────────

/**
 * First kitchen ticket for this business. On web the KOT is generated
 * server-side inside the order-create transaction (orderService →
 * kotService.generateTickets), so a 200 from POST /orders IS the KOT fire —
 * there is no separate "fire KOT" call to hook.
 */
export function trackFirstKot(opts: { orderId?: string | null }) {
  if (off() || hasFired('first_kot')) return;
  void (async () => {
    let stationCount = 0;
    try {
      const stations = await ffApi.listStations();
      stationCount = Array.isArray(stations) ? stations.length : 0;
    } catch {
      // 402 on Starter (kds is a paid feature) ⇒ genuinely zero configured
      // stations, which is the honest answer, not a missing value.
      stationCount = 0;
    }
    trackOnce('first_kot', {
      order_id: opts.orderId || null,
      station_count: stationCount,
      minutes_since_signup: minutesSinceSignup(),
    });
  })();
}

// ── 5. first_bill — THE activation event ─────────────────────────────────

export type PaymentMode = 'cash' | 'upi' | 'card' | 'split' | 'online' | 'wallet' | 'other';
export type ReceiptChannel = 'browser_print' | 'bluetooth' | 'whatsapp' | 'pdf' | 'none';

/**
 * First settled order carrying at least one owner-authored line.
 *
 * Idempotent per business, so it is safe to call from every settle path AND
 * from the receipt printers — whichever the owner reaches first wins, and
 * `receipt_channel` records how (or `none` when the bill was settled without
 * producing a receipt at all, which is itself worth knowing).
 */
export function trackFirstBill(opts: {
  orderId?: string | null;
  amountInr: number;
  paymentMode: string | null | undefined;
  receiptChannel: ReceiptChannel;
  lines: Array<{ name?: string | null; price?: number | string | null }>;
}) {
  if (off() || hasFired('first_bill')) return;
  // "Real" bill: excludes a wizard click-through that only ever billed the
  // three pre-filled demo rows.
  if (!hasOwnerAuthoredLine(opts.lines)) return;
  const mode = String(opts.paymentMode || '').toLowerCase();
  const known: PaymentMode[] = ['cash', 'upi', 'card', 'split', 'online', 'wallet'];
  trackOnce('first_bill', {
    order_id: opts.orderId || null,
    amount_inr: Math.round(Number(opts.amountInr) * 100) / 100,
    payment_mode: (known as string[]).includes(mode) ? mode : 'other',
    receipt_channel: opts.receiptChannel,
    line_items: opts.lines.length,
    minutes_since_signup: minutesSinceSignup(),
    within_24h: withinFirst24h(),
  });
}

// ── 6. upgrade_paid ──────────────────────────────────────────────────────

const TIER_KEY = 'np_funnel_tier_v1';

function lastSeenTier(businessId: string): string | null {
  try {
    const raw = localStorage.getItem(TIER_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v?.businessId === businessId && typeof v.tier === 'string' ? v.tier : null;
  } catch { return null; }
}

function rememberTier(businessId: string, tier: string) {
  try { localStorage.setItem(TIER_KEY, JSON.stringify({ businessId, tier })); }
  catch { /* storage disabled */ }
}

/**
 * Watch a subscription payload and fire once when it is a CONFIRMED paid
 * tier. The Razorpay webhook itself is server-side and invisible to the
 * browser, so the web-observable proof is the subscription row the webhook
 * writes: a non-free plan with status 'active'. The Razorpay checkout
 * handler firing is NOT enough — that is the client saying so.
 *
 * Call from any screen that already holds a subscription object.
 */
export function trackUpgradePaid(sub: any, businessId: string | null | undefined) {
  if (off() || !sub?.plan || !businessId) return;
  const tier = String(sub.plan.tier || '');
  if (!tier) return;
  const priceInr = Number(
    sub.billingPeriod === 'yearly' ? sub.plan.priceYearlyInr : sub.plan.priceInr,
  ) || 0;
  const isPaidTier = tier !== 'free' && priceInr > 0;
  const confirmed = sub.status === 'active';

  if (!isPaidTier || !confirmed) {
    // Still on a free/trialing plan: keep the "from" tier fresh so the
    // eventual upgrade reports where they actually came from.
    if (!hasFired('upgrade_paid')) rememberTier(businessId, tier || 'free');
    return;
  }
  if (hasFired('upgrade_paid')) return;
  trackOnce('upgrade_paid', {
    from_tier: lastSeenTier(businessId) || 'free',
    to_tier: tier,
    amount_inr: priceInr,
    billing_cycle: sub.billingPeriod === 'yearly' ? 'yearly' : 'monthly',
    days_since_signup: daysSinceSignup(),
    // Which cap pushed them over. This is the line that turns the pricing
    // cliff into revenue attribution.
    blocked_metric: lastBlockedMetric() || '',
  });
  rememberTier(businessId, tier);
}
