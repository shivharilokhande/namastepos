// NamastePOS dashboard — activation-funnel analytics (GA4).
//
// WHY THIS EXISTS
// The dashboard shipped no analytics at all, so nothing between "account
// created" and "first bill" could be seen. Marketing's activation audit
// (NamastePOS-Marketing/analytics/activation-2026-09-04.md) named seven
// events; this module is the ONLY place that talks to gtag. Everything
// else calls `track()` (or one of the helpers in lib/activation.ts).
//
// FOUR HARD RULES, in order of importance:
//
//  1. NO PII, EVER. This product ships a DPDP compliance console; leaking a
//     diner's phone number into Google Analytics would make that console a
//     lie. Enforcement is structural, not a code-review promise:
//       - every event has an ALLOW-LIST of property names (EVENT_PROPS);
//         anything not on it is dropped before the gtag call,
//       - values must be string / number / boolean / null — objects and
//         arrays are dropped whole, so nobody can pass `order` or
//         `customer` and hope for the best,
//       - a string that looks like an email, an Indian mobile number or a
//         JWT is dropped even if its key IS allow-listed,
//       - `user_id` is the business UUID. Never an email, never a phone.
//     There is deliberately no allow-listed key that can hold a person's
//     name, phone, email or address.
//
//  2. NO-OP WHEN UNCONFIGURED. If VITE_GA4_ID is empty, `track()` returns
//     immediately: no network, no gtag, no console output. A dashboard
//     without an analytics id must behave exactly as it did before this
//     file existed. Same for MODE/NODE_ENV === 'test'.
//
//  3. CONSENT FIRST. Analytics cookies are off by default in this app (see
//     components/CookieBanner) and the privacy policy says so. gtag is not
//     loaded, and nothing is sent, until the owner has actually granted
//     `cookies_analytics`. Events raised while the banner is still open are
//     held in memory (bounded) and flushed if consent is granted, dropped
//     if it is refused.
//
//  4. LAZY, ONCE. The gtag script is appended after first paint (idle
//     callback) and only ever once per page load.
//
// Milestone events (`business_created`, `menu_ready`, `first_kot`,
// `first_bill`, `upgrade_paid`) are FIRST-time-only per business — see
// `trackOnce`.

// ── Config ───────────────────────────────────────────────────────────────

const GA4_ID = ((import.meta.env.VITE_GA4_ID as string) || '').trim();

// Never in tests. Vitest/Vite set MODE; NODE_ENV covers a node-side runner.
const IS_TEST =
  (import.meta.env.MODE as string) === 'test'
  || (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test');

const HAS_WINDOW = typeof window !== 'undefined' && typeof document !== 'undefined';

/** Master switch. False ⇒ every exported function is a silent no-op. */
const ENABLED = !!GA4_ID && !IS_TEST && HAS_WINDOW;

/**
 * Exposed so lib/activation.ts can skip the *work* behind an event (a
 * subscription read for `over_plan_cap`, a station count for `first_kot`)
 * and not just the emit. Without this, an unconfigured dashboard would
 * still pay for network calls whose only consumer is analytics.
 */
export function analyticsEnabled(): boolean { return ENABLED; }

// Same key CookieBanner writes: { decision, analytics, marketing, at }.
const CONSENT_KEY = 'ff_cookie_decision_v1';
// One key for every milestone so an outlet switch can't wipe it —
// clearBusinessScopedStorage() drops any key that CONTAINS a business id,
// which is why the ids live in the value, not in the key name.
const MILESTONE_KEY = 'np_funnel_v1';
// Last plan metric that 403'd, for upgrade_paid.blocked_metric.
const BLOCKED_KEY = 'np_funnel_blocked_v1';

const MAX_QUEUE = 25;
const MAX_STRING = 100;

// ── Event contract ───────────────────────────────────────────────────────

export type FunnelEvent =
  | 'signup'
  | 'business_created'
  | 'menu_ready'
  | 'first_kot'
  | 'first_bill'
  | 'upgrade_paid'
  | 'plan_limit_hit';

export type PropValue = string | number | boolean | null;

/** Stamped on every event. `business_id` doubles as the GA4 user_id. */
const GLOBAL_PROPS = ['business_id', 'plan_tier', 'platform'] as const;

/**
 * The allow-list. A property name absent from this table never reaches
 * GA4 — that is how rule 1 is enforced. Note what is NOT here: no email,
 * phone, customer_name, staff_name, address, gstin, table label or item
 * name. Ids (business, order) are opaque UUIDs and are fine.
 */
const EVENT_PROPS: Record<FunnelEvent, readonly string[]> = {
  signup: ['method', 'has_business_name', 'referral_code'],
  business_created: ['is_new', 'category'],
  menu_ready: ['item_count', 'source', 'minutes_since_signup', 'over_plan_cap'],
  first_kot: ['order_id', 'station_count', 'minutes_since_signup'],
  first_bill: [
    'order_id', 'amount_inr', 'payment_mode', 'receipt_channel',
    'line_items', 'minutes_since_signup', 'within_24h',
  ],
  upgrade_paid: [
    'from_tier', 'to_tier', 'amount_inr', 'billing_cycle',
    'days_since_signup', 'blocked_metric',
  ],
  // `enforcement` (2026-09-04, decision 5) separates the two kinds of cliff:
  //   'hard' — the request was REFUSED (adding a dish, a staff login, a table)
  //   'soft' — the request SUCCEEDED past the included volume (a bill; a POS
  //            must never refuse one). Without this property the two collapse
  //            into one number and "how often does a cap actually stop
  //            someone" becomes unanswerable.
  plan_limit_hit: ['metric', 'limit', 'attempted', 'tier', 'enforcement'],
};

/** Milestones that must fire at most once per business. */
const ONCE_EVENTS: readonly FunnelEvent[] = [
  'business_created', 'menu_ready', 'first_kot', 'first_bill', 'upgrade_paid',
];

// ── Identity ─────────────────────────────────────────────────────────────

export interface AnalyticsIdentity {
  /** Business UUID. Opaque — safe to send, and used as the GA4 user_id. */
  businessId: string | null;
  /**
   * Signup instant. Derived from the EXISTING `business.createdAt` field
   * (authService.serializeBusiness → businesses.created_at) — self
   * registration creates the business inline with the account, so business
   * creation IS signup. No new server field was invented for this.
   */
  signupAt: string | null;
  /**
   * plan.tierKind from /auth/me — a tier KIND, one of @/lib/planTiers
   * TIER_KIND_LADDER ('starter' | 'pro' | 'pro_plan' | 'advanced' |
   * 'enterprise'). NOT a plans.tier code: kind 'pro' is the Growth plan.
   */
  planTier?: string | null;
}

let identityProvider: (() => AnalyticsIdentity | null) | null = null;

/**
 * Wire the module to the app's session state. Called ONCE from main.tsx so
 * this file imports nothing from the app (which is what keeps api/client.ts
 * → analytics.ts a one-way dependency, no import cycle).
 */
export function setIdentityProvider(fn: () => AnalyticsIdentity | null) {
  identityProvider = fn;
}

function identity(): AnalyticsIdentity {
  if (!identityProvider) return { businessId: null, signupAt: null, planTier: null };
  try {
    return identityProvider() || { businessId: null, signupAt: null, planTier: null };
  } catch {
    return { businessId: null, signupAt: null, planTier: null };
  }
}

// ── Time helpers (derived from business.createdAt — no new server field) ──

function elapsedMs(): number | null {
  const at = identity().signupAt;
  if (!at) return null;
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return null;
  const d = Date.now() - t;
  return d >= 0 ? d : 0;
}

/** Whole minutes from signup to now, or null when the timestamp is unknown. */
export function minutesSinceSignup(): number | null {
  const ms = elapsedMs();
  return ms === null ? null : Math.round(ms / 60_000);
}

/** Whole days from signup to now, or null when the timestamp is unknown. */
export function daysSinceSignup(): number | null {
  const ms = elapsedMs();
  return ms === null ? null : Math.floor(ms / 86_400_000);
}

/** The activation window. Null when the signup timestamp is unknown. */
export function withinFirst24h(): boolean | null {
  const ms = elapsedMs();
  return ms === null ? null : ms <= 86_400_000;
}

// ── Consent ──────────────────────────────────────────────────────────────

function consentState(): 'granted' | 'refused' | 'undecided' {
  if (!HAS_WINDOW) return 'undecided';
  try {
    const raw = localStorage.getItem(CONSENT_KEY);
    if (!raw) return 'undecided';
    return JSON.parse(raw)?.analytics === true ? 'granted' : 'refused';
  } catch {
    return 'refused';
  }
}

/**
 * Called by CookieBanner the moment a decision is persisted, so a freshly
 * granted consent flushes the held events instead of waiting for a reload.
 */
export function refreshConsent() {
  if (!ENABLED) return;
  const state = consentState();
  if (state === 'granted') { ensureLoaded(); flush(); }
  else if (state === 'refused') { queue.length = 0; }
}

// ── Sanitisation ─────────────────────────────────────────────────────────

// Non-global on purpose: a /g/ regex carries lastIndex across .test() calls.
const RE_EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const RE_INDIAN_MOBILE = /(?:\+?91[- ]?)?[6-9]\d{9}\b/;
const RE_JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/;

/**
 * Returns the value to send, or `undefined` to drop the property entirely.
 * Objects and arrays are ALWAYS dropped — that closes the "just pass the
 * whole order/customer object" hole permanently.
 */
function safeValue(v: unknown): PropValue | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const s = v.trim().slice(0, MAX_STRING);
  if (!s) return '';
  if (RE_EMAIL.test(s) || RE_INDIAN_MOBILE.test(s) || RE_JWT.test(s)) return undefined;
  return s;
}

function buildParams(
  event: FunnelEvent,
  props: Record<string, unknown> | undefined,
): Record<string, PropValue> {
  const id = identity();
  const allowed = new Set<string>([...GLOBAL_PROPS, ...EVENT_PROPS[event]]);
  const merged: Record<string, unknown> = {
    business_id: id.businessId,
    plan_tier: id.planTier ?? null,
    platform: 'web',
    ...(props || {}),
  };
  const out: Record<string, PropValue> = {};
  for (const [k, raw] of Object.entries(merged)) {
    if (!allowed.has(k)) {
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn(`[analytics] dropped un-allow-listed prop "${k}" on ${event}`);
      }
      continue;
    }
    const v = safeValue(raw);
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

// ── gtag loader (lazy, once, after first paint) ──────────────────────────

let loaded = false;
let scheduled = false;
const queue: Array<{ event: string; params: Record<string, PropValue> }> = [];

// Define the canonical gtag shim rather than pushing plain arrays:
// gtag.js expects each dataLayer entry to be an `arguments` object, and
// `function(){dataLayer.push(arguments)}` is the shape Google documents.
function gtagPush(...args: unknown[]) {
  const w = window as unknown as {
    dataLayer?: unknown[];
    gtag?: (...a: unknown[]) => void;
  };
  w.dataLayer = w.dataLayer || [];
  if (!w.gtag) {
    // eslint-disable-next-line func-names, prefer-rest-params
    w.gtag = function () { (w.dataLayer as unknown[]).push(arguments); };
  }
  w.gtag(...args);
}

function ensureLoaded() {
  if (loaded || !ENABLED) return;
  loaded = true;
  gtagPush('js', new Date());
  gtagPush('config', GA4_ID, {
    // The dashboard is auth-gated and some routes carry tokens in the path
    // (/qr/:token, /track/:token). Automatic page_view would ship those
    // URLs to GA4; we only want the seven funnel events.
    send_page_view: false,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });
  const s = document.createElement('script');
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA4_ID)}`;
  // The tag drains window.dataLayer on load, so events queued into it
  // before the script arrives are not lost.
  document.head.appendChild(s);
}

function flush() {
  if (!loaded) return;
  while (queue.length > 0) {
    const item = queue.shift()!;
    gtagPush('event', item.event, item.params);
  }
}

/**
 * Schedule the gtag load. Safe to call more than once; the script is only
 * ever appended once, and only if analytics is configured AND consented.
 */
export function initAnalytics() {
  if (!ENABLED || scheduled) return;
  scheduled = true;
  const run = () => { if (consentState() === 'granted') { ensureLoaded(); flush(); } };
  const w = window as unknown as { requestIdleCallback?: (cb: () => void) => void };
  if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(run);
  else window.setTimeout(run, 1500);
}

// ── The only public emitter ───────────────────────────────────────────────

/**
 * Send one funnel event. Silent no-op when analytics is unconfigured.
 *
 *   track('plan_limit_hit', { metric: 'menu_items', limit: 10, attempted: 11 })
 */
export function track(event: FunnelEvent, props?: Record<string, unknown>): void {
  if (!ENABLED) return;
  let params: Record<string, PropValue>;
  try {
    params = buildParams(event, props);
  } catch {
    return; // analytics must never break the app
  }
  const state = consentState();
  if (state === 'refused') return;
  if (state === 'undecided') {
    // Banner still open. Hold (bounded, in memory only) — nothing leaves
    // the browser until consent is actually granted.
    if (queue.length < MAX_QUEUE) queue.push({ event, params });
    return;
  }
  ensureLoaded();
  const id = identity();
  if (id.businessId) gtagPush('set', { user_id: id.businessId });
  if (queue.length > 0) flush();
  gtagPush('event', event, params);
}

// ── First-time-only milestones ───────────────────────────────────────────

type MilestoneMap = Record<string, string>;

function readMilestones(): MilestoneMap {
  if (!HAS_WINDOW) return {};
  try {
    const raw = localStorage.getItem(MILESTONE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? (parsed as MilestoneMap) : {};
  } catch {
    return {};
  }
}

function milestoneKey(event: FunnelEvent, businessId: string) {
  return `${event}:${businessId}`;
}

/** True when this milestone has already been recorded for this business. */
export function hasFired(event: FunnelEvent): boolean {
  const bid = identity().businessId;
  if (!bid) return false;
  return !!readMilestones()[milestoneKey(event, bid)];
}

/**
 * Fire a milestone exactly once per business.
 *
 * WHERE THE STATE LIVES: `localStorage.np_funnel_v1`, a single JSON map of
 * `"<event>:<businessId>" -> ISO timestamp`. Business ids sit in the VALUE
 * side of the key string but the storage key itself is business-agnostic,
 * so `clearBusinessScopedStorage()` (which nukes any key containing a
 * business id on outlet switch) leaves it alone.
 *
 * FAILURE MODE — deliberately accepted for a marketing funnel:
 *   • per browser profile. The owner billing from the counter PC after
 *     activating on their phone re-fires the milestone; GA4 will show a
 *     small over-count of first-time events (dedupe on business_id in the
 *     report if it matters).
 *   • cleared site data / private window / storage disabled ⇒ re-fires.
 *   • the guard is written BEFORE the event leaves the browser, so a
 *     refused-consent decision consumes the milestone. That is fine: with
 *     analytics off there is nothing to report anyway.
 *
 * Returns true if the event was emitted, false if it had already fired.
 */
export function trackOnce(event: FunnelEvent, props?: Record<string, unknown>): boolean {
  if (!ENABLED) return false;
  if (!ONCE_EVENTS.includes(event)) { track(event, props); return true; }
  const bid = identity().businessId;
  // No business id ⇒ we cannot key the milestone, so we must not fire: an
  // unkeyed event would repeat on every render.
  if (!bid) return false;
  const key = milestoneKey(event, bid);
  const all = readMilestones();
  if (all[key]) return false;
  all[key] = new Date().toISOString();
  try { localStorage.setItem(MILESTONE_KEY, JSON.stringify(all)); }
  catch { /* storage disabled — event still fires, may repeat */ }
  track(event, props);
  return true;
}

// ── plan_limit_hit → upgrade_paid.blocked_metric ─────────────────────────

/** Remember the plan metric that last refused this owner. */
export function recordBlockedMetric(metric: string) {
  if (!ENABLED || !HAS_WINDOW) return;
  const bid = identity().businessId;
  if (!bid || !metric) return;
  try {
    localStorage.setItem(BLOCKED_KEY, JSON.stringify({ businessId: bid, metric }));
  } catch { /* storage disabled */ }
}

/** The metric that last 403'd, so upgrade_paid can say what forced it. */
export function lastBlockedMetric(): string | null {
  if (!HAS_WINDOW) return null;
  const bid = identity().businessId;
  if (!bid) return null;
  try {
    const raw = localStorage.getItem(BLOCKED_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return v?.businessId === bid && typeof v.metric === 'string' ? v.metric : null;
  } catch {
    return null;
  }
}
