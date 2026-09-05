// NamastePOS dashboard - business-scoped API helpers

import { api, getBusinessCache } from './client';

/**
 * POST a body that may carry `plan`, tolerating an API that predates the field.
 *
 * The two halves of this app deploy independently (Cloudflare Pages vs Render),
 * so a new client can meet an old server. The auth schemas use
 * `allowUnknown: false`, which turns an unknown field into a 400 rather than an
 * ignored key — and a 400 here means a failed signup. Retry once without
 * `plan`: the trial then uses the server's TRIAL_PLAN_TIER default, which is a
 * far smaller loss than the account.
 *
 * Only retries on the specific "not allowed" validation failure for `plan`, so
 * a genuine validation error (bad email, weak password) still surfaces as-is
 * and is never silently retried.
 */
async function postTolerantOfPlan(path: string, body: Record<string, unknown>) {
  try {
    const r = await api.post(path, body);
    return r.data;
  } catch (e: any) {
    const details: unknown = e?.response?.data?.details;
    const rejectedPlan = e?.response?.status === 400
      && body.plan !== undefined
      && Array.isArray(details)
      && details.some((d) => typeof d === 'string' && /\bplan\b/.test(d) && /not allowed/i.test(d));
    if (!rejectedPlan) throw e;
    const { plan, ...withoutPlan } = body;
    void plan;
    const r = await api.post(path, withoutPlan);
    return r.data;
  }
}

// Push 15d — trigger a save-as in the browser for a Blob (PDF/XLSX/CSV).
// axios is the auth path so the file is fetched WITH the Bearer token;
// once we have the blob in memory we synthesise an <a download> click
// and immediately revoke the object URL.
function _triggerBlobDownload(data: Blob, filename: string) {
  const url = URL.createObjectURL(data);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Plan limits + past-due grace (2026-09-04) ────────────────────────────
//
// Both ride on GET /businesses/:id/billing, the call the dashboard and the
// mobile app already make. They exist so an owner can never hit a plan wall
// (or lose features to a failed card) without having been told first —
// before this, the 80%-of-cap warning lived only in the super-admin console
// and `past_due` stripped features the instant the webhook landed.

/** One capped metric on the effective plan. Unlimited metrics are omitted. */
export interface PlanUsageMetric {
  metric: 'monthly_orders' | 'menu_items' | 'staff' | 'tables' | 'floors' | string;
  /** Owner-readable name, e.g. "bills this month". */
  label: string;
  limit: number;
  current: number;
  remaining: number;
  /** Percent of the cap used. Can exceed 100 after a reconciliation. */
  pct: number;
  /** ok < 80% | warn >= 80% | critical >= 100%. */
  level: 'ok' | 'warn' | 'critical';
  /**
   * What happens AT the cap (2026-09-04, decision 5). The banner must branch
   * on this, not on the metric name:
   *   'hard' — the next attempt is refused with a 403 (dishes, staff, tables,
   *            floors, outlets: configuration actions, nobody is waiting)
   *   'soft' — nothing is refused; the extra is recorded as overage
   *            (`monthly_orders` — a POS must never refuse a bill)
   * Absent on an older server: treat as 'hard', which is what it used to be.
   */
  enforcement?: 'soft' | 'hard';
  /** Units past the cap. 0 unless `level` is critical on a soft metric. */
  over?: number;
  /** Plain-language line to show the owner. */
  message: string;
}

/**
 * Recorded overage for the current period on a SOFT metric. Present on the
 * billing read only while the tenant is actually past their included volume.
 */
export interface PlanOverage {
  metric: string;
  period: string;
  /** The included volume that applied. */
  included: number | null;
  /** Total used this period. */
  used: number;
  /** How many of those were past `included`. */
  over: number;
  firstAt: string | null;
  lastAt: string | null;
}

export interface PlanUsage {
  planTier: string | null;
  planName: string | null;
  /**
   * False when the plan being metered is NOT the subscribed plan — a lapsed
   * trial or a past-grace `past_due`, both of which fall back to Starter's
   * caps. Lets the banner explain why the numbers changed.
   */
  entitled: boolean;
  reason: string;
  warnAtPct: number;
  metrics: PlanUsageMetric[];
}

/** Present only while a failed charge is inside the grace window. */
export interface PastDueGrace {
  inGrace: true;
  graceEndsAt: string;
  graceDaysLeft: number;
  graceDays: number;
  amountInr: number | null;
  message: string;
}

/**
 * Only the fields this change introduced are typed narrowly. `status` and
 * `plan` are named because the banners branch on them; everything else stays
 * permissive (`any` via the index signature) so the existing pages that read
 * this object — BillingPage, StaffPage, lib/activation — keep compiling
 * exactly as they did when the call was untyped. Tightening the rest is a
 * separate job, not a side effect of adding a banner.
 */
export interface Subscription {
  /** 'trialing' | 'active' | 'past_due' | 'paused' | 'cancelled' | 'suspended' (2026-09-06) */
  status: string;
  plan: Record<string, any> | null;
  usage?: PlanUsage | null;
  grace?: PastDueGrace | null;
  overage?: PlanOverage | null;
  pause?: PauseState | null;
  // 2026-09-06 (round 2, CONTRACTS §6) — additive fields on GET /billing.
  /** A scheduled downgrade: where the account lands on `effectiveAt` (falls back to currentPeriodEnd). */
  pendingPlan?: { code?: string; tier?: string; name?: string; effectiveAt?: string | null } | null;
  /** Admin suspension block; present only while status === 'suspended'. */
  suspension?: { since?: string | null; message?: string | null } | null;
  /** A re-checkout was completed and we are waiting for its first charge. */
  reactivationPending?: boolean;
  [key: string]: any;
}

// ── Cancel flow, pause, export (2026-09-05, churn batch) ─────────────────

/** Present on the billing read only while the account is paused. */
export interface PauseState {
  paused: true;
  pausedAt: string;
  pauseEndsAt: string;
  pauseMonths: number | null;
  message: string;
}

export interface CancelReason {
  code: string;
  label: string;
  /** Free text is mandatory for this reason (missing_feature). */
  noteRequired: boolean;
}

export interface SaveOfferOption {
  action: 'downgrade' | 'pause' | 'annual' | 'founder_call' | string;
  title: string;
  detail: string;
  tier?: string;
  months?: number[];
}

/**
 * The offer the REASON produced.
 *
 * `save: false` means we are deliberately not trying to save them —
 * missing_feature, switching and closing_down all return it, with an empty
 * `options`. The UI must render those branches with NO "stay" button: a save
 * offer shown to somebody whose restaurant has shut is insulting.
 */
export interface SaveOffer {
  kind: 'downgrade_or_pause' | 'pause' | 'founder_note' | 'goodbye' | string;
  save: boolean;
  headline: string;
  detail?: string;
  exportPath?: string;
  options: SaveOfferOption[];
}

export interface CancelSurveyResult {
  survey: {
    id: string;
    reason: string;
    reasonLabel: string;
    note: string | null;
    offerKind: string;
    outcome: string;
  };
  offer: SaveOffer;
}

// ── Multi-outlet types (2026-09-03) ──────────────────────────────────────
// One row per business the SIGNED-IN user holds an active business_users
// row for. GET /outlet-groups/my-outlets is deliberately NOT plan-gated,
// so a single-outlet tenant still gets exactly one row.
export interface MyOutlet {
  businessId: string;
  name: string;
  outletLabel: string;
  city: string | null;
  groupId: string | null;
  groupName: string | null;
  isParent: boolean;
  role: string;
  current: boolean;
}

// ── /auth/me (D-20, 2026-09-05) ──────────────────────────────────────────
// Mirrors authController.me + featureService.planSummary. `plan` is null when
// the user has no active business OR when planSummary threw server-side —
// usePlan() treats both as "nothing granted" (fail-closed). `permissions` is
// null for the owner (= all) and an explicit allow-list for staff.
export interface MePlan {
  tier?: string; // plan CODE (free/basic/pro_plan/advanced/pro) — display only, never gate on it
  tierKind: string;
  tierLabel?: string;
  nextTierKind?: string | null;
  nextTierLabel?: string | null;
  features: string[];
  planVersion?: string | number | null;
}
// 2026-09-05 — the declared GST scheme (migration 092) rides on the business
// block of /auth/me (authService.serializeBusiness → `gstScheme`, 'regular'
// for every business that has not answered yet). The POS reads it to decide
// whether to show/collect GST at all: a composition dealer issues a bill of
// supply and charges the diner nothing. Index signature keeps every other
// consumer of the (previously `any`) business block compiling unchanged.
export type GstScheme = 'regular' | 'composition' | 'specified_premises';
export interface MeBusiness {
  id: string;
  gstScheme?: GstScheme | string | null;
  [key: string]: any;
}
export interface MeResponse {
  user: any;
  business: MeBusiness;
  role: string | null;
  memberships: { businessId: string; role: string }[];
  plan: MePlan | null;
  permissions: string[] | null;
  hasPassword?: boolean;
}

// ── Gift cards (FF-1005 canonical ledger, payments.routes.js) ─────────────
// Row shape is the raw `gift_cards` table row: money columns are paise.
export interface GiftCardRow {
  id: string;
  code: string;
  face_value_paise: number;
  balance_paise: number;
  issued_to_phone: string | null;
  expires_at: string | null;
  created_at?: string;
}

export interface SwitchBusinessResult {
  token: string;
  // Blank in cookie-auth mode (the backend Set-Cookie's `ff_refresh`
  // instead) — see client.ts `X-Auth-Mode: cookie`.
  refreshToken?: string | null;
  business: any;
  role: string | null;
  plan: { tierKind: string; features: string[] } | null;
  memberships: { businessId: string; role: string }[];
}

export interface ProvisionOutletResult {
  outlet: { id: string; name: string; outlet_label: string | null; city: string | null };
  groupId: string;
}

export interface OutletRollup {
  outlets: {
    businessId: string;
    name: string;
    outletLabel: string | null;
    metrics: { orders: number; gross: number; food_cost_paise: number | string };
  }[];
  totals: { orders: number; grossInr: number; foodCostInr: number };
}

// ── Delivery fulfilment lifecycle (2026-09-04) ───────────────────────────
// One row per LIVE delivery order (delivered / rejected / cancelled are
// excluded server-side). `nextStates` is authoritative — the UI must render
// its action buttons from it and never from a hardcoded ladder, because the
// backend owns the transition graph (and aggregator-sourced orders can skip
// rungs the own-fleet flow uses).
export type FulfilmentState =
  | 'placed' | 'accepted' | 'preparing' | 'food_ready'
  | 'rider_assigned' | 'picked_up' | 'delivered'
  | 'rejected' | 'cancelled';

export interface FulfilmentOrder {
  id: string;
  orderNo: string | number;
  source: string | null;
  channel: string | null;
  posStatus: string | null;
  state: FulfilmentState;
  prepMinutes: number | null;
  customerName: string | null;
  customerPhone: string | null;
  total: number | string;
  rider: { name: string; phone: string } | null;
  // When true the delivery partner reads out a handover code the staff must
  // TYPE — we never receive or render the expected value.
  otpRequired: boolean;
  otpVerified: boolean;
  aggregatorOrderId: string | null;
  createdAt: string;
  acceptedAt: string | null;
  foodReadyAt: string | null;
  pickedUpAt: string | null;
  nextStates: FulfilmentState[];
  rejectReason?: string | null;
}

export interface FulfilmentTransitionBody {
  state: FulfilmentState;
  // Required (1-240) when state === 'accepted'.
  prepMinutes?: number;
  // Required when state === 'rejected'.
  reason?: string;
  rider?: { name?: string; phone?: string; otp?: string };
  // Required when moving to 'picked_up' on an order with otpRequired.
  otp?: string;
}

// ── Round-2 contracts (2026-09-06, CONTRACTS_round2.md) ──────────────────
// Camel-case on the wire; money as `*Paise` integers. The dashboard converts
// rupees ↔ paise at the form boundary only (Math.round(inr * 100)) so nothing
// downstream ever holds a float rupee amount.

/** §1 — B2B invoice template, its own store (migration 095), gated `b2b_invoice`. */
export interface B2BInvoiceTemplate {
  letterhead: string;
  terms: string;
  signatureUrl: string;
  bankDetails: string;
  showHsn: boolean;
  showEway: boolean;
}

/** §2 — recurring invoices. */
export type RecurringFrequency = 'weekly' | 'monthly' | 'quarterly' | 'yearly';
export interface RecurringInvoiceItem {
  name: string;
  hsn?: string | null;
  qty: number;
  unitPricePaise: number;
  gstPct: number;
}
export interface RecurringSchedule {
  id: string;
  name: string;
  customerId: string;
  customerName: string | null;
  frequency: RecurringFrequency;
  nextRunAt: string | null;
  endDate: string | null;
  isActive: boolean;
  items: RecurringInvoiceItem[];
  notes: string | null;
  totalPaise: number;
  lastRunAt: string | null;
  lastInvoiceId: string | null;
  runCount: number;
}
export interface RecurringScheduleBody {
  name: string;
  customerId: string;
  frequency: RecurringFrequency;
  startDate: string; // YYYY-MM-DD
  endDate?: string | null;
  items: RecurringInvoiceItem[];
  notes?: string | null;
}
export interface RecurringRunNowResult {
  schedule: RecurringSchedule;
  invoice: { id: string; invoiceNo: string; totalPaise: number };
}

/** §3 — tenant API keys. `secret` is returned by POST exactly once. */
export interface ApiKeyRow {
  id: string;
  label: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}
export interface ApiKeyCreated {
  key: Pick<ApiKeyRow, 'id' | 'label' | 'prefix' | 'createdAt'>;
  secret: string;
}

/** §4 — white label. */
export interface WhiteLabel {
  enabled: boolean;
  brandName: string;
  hidePoweredBy: boolean;
  accentColor: string | null;
}

export const ffApi = {
  // Auth
  // `plan` (2026-09-04): the plan card the visitor clicked, forwarded from
  // `?plan=` on the signup link. The backend provisions the 7-day trial on
  // THAT plan instead of always on Starter, so "Start free trial" on the Pro
  // card now actually trials Pro. Ignored for an existing user (Google
  // sign-in is find-or-create), and an unknown tier silently falls back to
  // the default — it is not a way to grant yourself a plan.
  // FORWARD-COMPATIBILITY (2026-09-04, learned the hard way).
  //
  // `plan` was added to these two payloads in the same commit as the server
  // side that accepts it — but the dashboard deploys via Cloudflare Pages and
  // the API via Render, INDEPENDENTLY. Render's build failed on that push
  // (it had lost repo access when the repo went private) while Pages
  // succeeded, so for a while a new dashboard was posting `plan` to an old
  // API whose Joi schema is `allowUnknown: false`. It answered
  // `"plan" is not allowed` — a 400 on every signup that came from a pricing
  // card. Registration, the single thing the whole funnel exists to reach.
  //
  // So these no longer assume the two halves ship together: send `plan`, and
  // if the server rejects it as an unknown field, drop it and retry once.
  // Losing `plan` is harmless — the trial plan then falls back to the
  // TRIAL_PLAN_TIER default — whereas losing the signup is not. The retry
  // costs one request only on an API that predates the field, and disappears
  // by itself once the API catches up.
  googleLogin: (idToken: string, plan?: string) =>
    postTolerantOfPlan('/auth/google', { idToken, plan }),
  passwordLogin: (email: string, password: string) =>
    api.post('/auth/login', { email, password }).then((r) => r.data),
  register: (body: { email: string; password: string; name?: string; businessName?: string; referralCode?: string; plan?: string }) =>
    postTolerantOfPlan('/auth/register', body),
  me: (): Promise<MeResponse> => api.get('/auth/me').then((r) => r.data as MeResponse),
  patchMe: (patch: any) => api.patch('/auth/me', patch).then((r) => r.data),

  // Image upload
  uploadImage: (file: File) => {
    const b = getBusinessCache();
    const fd = new FormData();
    fd.append('file', file);
    return api.post(`/businesses/${b.id}/uploads`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then((r) => r.data);
  },

  // Menu
  listMenu: () => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/menu`).then((r) => r.data.items);
  },
  // NP-205 — same list, but each item carries `variants: [...]` (label, price,
  // stock, trackStock). A SEPARATE binding rather than a parameter on
  // listMenu, because listMenu is passed to react-query bare
  // (`queryFn: ffApi.listMenu`) and would receive the QueryFunctionContext as
  // its first argument. Needed by the POS picker (which read `item.variants`
  // from a payload that never contained it) and by the inventory screen.
  listMenuWithVariants: () => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/menu`, { params: { withVariants: true } })
      .then((r) => r.data.items);
  },
  createMenuItem: (body: any) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/menu`, body).then((r) => r.data.item);
  },
  updateMenuItem: (id: string, body: any) => {
    const b = getBusinessCache();
    return api.put(`/businesses/${b.id}/menu/${id}`, body).then((r) => r.data.item);
  },
  deleteMenuItem: (id: string) => {
    const b = getBusinessCache();
    return api.delete(`/businesses/${b.id}/menu/${id}`).then((r) => r.data);
  },
  // FF-218: bulk CSV import for menu items. Body is [{name, price, category, ...}, ...].
  bulkImportMenu: (items: any[]) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/menu/bulk`, { items }).then((r) => r.data);
  },

  // ── Activation (2026-09-05): the three routes out of the menu wall ──────
  //
  // Manual menu entry is 45-90 minutes on a phone and it sits between signup
  // and the first bill (activation audit 2026-09-04). CSV import only helps an
  // owner who already HAS an export. These two cover the rest.
  //
  // 1. Starter templates. `applyMenuTemplate` sends ONLY the slug — every
  //    name, price, GST rate and HSN code is read server-side off disk, so
  //    the client cannot set a price through this path.
  listMenuTemplates: () => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/menu/templates`).then((r) => r.data.templates);
  },
  getMenuTemplate: (slug: string) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/menu/templates/${slug}`).then((r) => r.data.template);
  },
  applyMenuTemplate: (slug: string) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/menu/templates/${slug}/apply`, {})
      .then((r) => r.data);
  },
  // 2. Paste a menu. Parse-only — it writes nothing. The rows the owner
  //    confirms are posted through `bulkImportMenu` above, which is the
  //    plan-capped, all-or-nothing path.
  parseMenuText: (text: string, defaultCategory?: string) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/menu/parse-text`, { text, defaultCategory })
      .then((r) => r.data);
  },
  // Migration wizard (2026-09-03) — "Switch to NamastePOS" imports. Both
  // return { imported, failed: [{row,error}], warnings: [{row,warning}] }.
  importCustomers: (rows: any[]) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/imports/customers`, { rows }).then((r) => r.data);
  },
  importSalesHistory: (rows: any[]) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/imports/sales-history`, { rows }).then((r) => r.data);
  },
  importExpenses: (rows: any[]) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/imports/expenses`, { rows }).then((r) => r.data);
  },
  // FF-244 owner inbox
  actionCenter: () => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/action-center`).then((r) => r.data);
  },
  // FF-246 revenue leakage
  revenueLeakage: (from?: string, to?: string) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/reports/leakage`,
      { params: { from, to } }).then((r) => r.data);
  },
  // 2026-08-23 — owner-facing refunds list, scoped to this business. Backs
  // the Refunds page so refund history is visible on the owner's own
  // dashboard (previously only on the platform admin panel).
  listRefunds: (params?: { status?: string; limit?: number }) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/refunds`, { params }).then((r) => r.data.refunds);
  },
  // FF-304 partial refund for an order
  refundOrder: (orderId: string, body: { itemIds?: string[]; amountInr?: number; reason?: string }) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/orders/${orderId}/refund`, body).then((r) => r.data);
  },

  // Orders
  listOrders: (params: any = {}) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/orders`, { params }).then((r) => r.data.orders);
  },
  // Paged variant: returns { orders, total, count } for server-side pagination.
  listOrdersPaged: (params: any = {}) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/orders`, { params }).then((r) => r.data);
  },
  // Walk-in / counter order from the web dashboard (mirrors the mobile POS).
  createOrder: (body: any) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/orders`, body).then((r) => r.data.order);
  },
  updateOrderStatus: (orderId: string, status: string, reason?: string, reasonCode?: string) => {
    const b = getBusinessCache();
    return api.put(`/businesses/${b.id}/orders/${orderId}/status`,
      { status, reason, reasonCode }).then((r) => r.data);
  },
  // Sprint 1 — reprint, variants, modifiers, 86, cancel reasons, bill template
  reprintOrder: (orderId: string) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/orders/${orderId}/reprint`).then((r) => r.data);
  },
  listVariants: (itemId: string) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/menu/${itemId}/variants`).then((r) => r.data.variants);
  },
  setVariants: (itemId: string, variants: any[]) => {
    const b = getBusinessCache();
    return api.put(`/businesses/${b.id}/menu/${itemId}/variants`, { variants }).then((r) => r.data);
  },
  listModifierGroups: () => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/modifier-groups`).then((r) => r.data.groups);
  },
  upsertModifierGroup: (body: any) => {
    const b = getBusinessCache();
    return api.put(`/businesses/${b.id}/modifier-groups`, body).then((r) => r.data.groups);
  },
  setItemModifierGroups: (itemId: string, groupIds: string[]) => {
    const b = getBusinessCache();
    return api.put(`/businesses/${b.id}/menu/${itemId}/modifier-groups`, { groupIds }).then((r) => r.data);
  },
  getItemModifierGroups: (itemId: string) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/menu/${itemId}/modifier-groups`).then((r) => r.data.groupIds || []);
  },
  toggleSoldOut: (itemId: string, until: string | null) => {
    const b = getBusinessCache();
    return api.put(`/businesses/${b.id}/menu/${itemId}/sold-out`, { until }).then((r) => r.data);
  },
  listCancelReasons: () => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/cancel-reasons`).then((r) => r.data.reasons);
  },
  getBillTemplate: () => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/bill-template`).then((r) => r.data.template);
  },
  updateBillTemplate: (body: any) => {
    const b = getBusinessCache();
    return api.put(`/businesses/${b.id}/bill-template`, body).then((r) => r.data.template);
  },

  // ── Sprints 2-10 ────────────────────────────────────────────────────────
  // Aggregators
  listAggregators: () => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/aggregators`).then((r) => r.data.credentials); },
  saveAggregator: (body: any) => { const b = getBusinessCache(); return api.put(`/businesses/${b.id}/aggregators`, body).then((r) => r.data.credentials); },
  listMappingIssues: () => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/aggregators/mapping-issues`).then((r) => r.data.issues); },
  setExternalSku: (itemId: string, provider: string, sku: string) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/aggregators/menu-items/${itemId}/sku`, { provider, sku }).then((r) => r.data); },
  // Daily closing
  previewClosing: (date?: string) => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/daily-closings/preview`, { params: { date } }).then((r) => r.data.preview); },
  listClosings: () => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/daily-closings`).then((r) => r.data.closings); },
  closeDay: (body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/daily-closings`, body).then((r) => r.data.closing); },
  // Wastage
  wastageReport: (params?: any) => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/wastage`, { params }).then((r) => r.data.report); },
  logWastage: (body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/wastage`, body).then((r) => r.data.entry); },
  // Reservations
  listReservations: (params?: any) => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/reservations`, { params }).then((r) => r.data.reservations); },
  createReservation: (body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/reservations`, body).then((r) => r.data.reservation); },
  updateReservation: (id: string, patch: any) => { const b = getBusinessCache(); return api.put(`/businesses/${b.id}/reservations/${id}`, patch).then((r) => r.data.reservation); },
  seatReservation: (id: string) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/reservations/${id}/seat`).then((r) => r.data.reservation); },
  listWaitList: () => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/wait-list`).then((r) => r.data.entries); },
  addToWaitList: (body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/wait-list`, body).then((r) => r.data.entry); },
  // Discount approvals
  approveDiscount: (body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/discount-approvals`, body).then((r) => r.data.approval); },
  setDiscountThreshold: (inr: number) => { const b = getBusinessCache(); return api.put(`/businesses/${b.id}/discount-approvals/threshold`, { inr }).then((r) => r.data); },
  setMyDiscountPin: (pin: string) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/me/discount-pin`, { pin }).then((r) => r.data); },
  // Customer history
  customerProfile: (phone: string) => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/customer-history/${phone}`).then((r) => r.data); },
  reorderSameAsLast: (customerId: string) => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/customers/${customerId}/reorder-last`).then((r) => r.data.items); },
  // Memberships + gift cards
  listMemberships: () => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/memberships`).then((r) => r.data.memberships); },
  createMembership: (body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/memberships`, body).then((r) => r.data.membership); },
  updateMembership: (id: string, body: any) => { const b = getBusinessCache(); return api.put(`/businesses/${b.id}/memberships/${id}`, body).then((r) => r.data.membership); },
  deleteMembership: (id: string) => { const b = getBusinessCache(); return api.delete(`/businesses/${b.id}/memberships/${id}`).then((r) => r.data); },
  membershipSubscribers: () => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/memberships/subscribers`).then((r) => r.data.subscribers); },
  // D-03 (2026-09-05): aligned to payments.routes.js (FF-1005 canonical
  // ledger). The previous helpers were written against the retired dual-
  // ledger API: they read `r.data.giftCards` (server sends `{ cards }`),
  // posted `amountInr/purchaserPhone` (server Joi requires `faceValueInr`
  // and rejects unknown fields → 400 on every issue), unwrapped
  // `r.data.giftCard` (server returns the raw row), and called
  // POST /gift-cards/:code/redeem, which does not exist — redemption
  // happens through the order/settle flow (wallet legs), not a standalone
  // route, so there is no redeem helper here.
  listGiftCards: (): Promise<GiftCardRow[]> => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/gift-cards`).then((r) => (r.data.cards || []) as GiftCardRow[]); },
  issueGiftCard: (body: { faceValueInr: number; issuedToPhone?: string | null; expiresAt?: string | null }): Promise<GiftCardRow> => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/gift-cards`, body).then((r) => r.data as GiftCardRow);
  },
  lookupGiftCard: (code: string) => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/gift-cards/lookup/${encodeURIComponent(code)}`).then((r) => r.data.card as { code: string; balance: number; expiresAt: string | null } | null); },
  recordTip: (body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/tips`, body).then((r) => r.data.tip); },
  tipReport: (params?: any) => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/tips/report`, { params }).then((r) => r.data.report); },
  // Printers
  listPrinters: () => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/printers`).then((r) => r.data.printers); },
  upsertPrinter: (body: any) => { const b = getBusinessCache(); return api.put(`/businesses/${b.id}/printers`, body).then((r) => r.data.printer); },
  // Drivers
  listDrivers: () => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/drivers`).then((r) => r.data.drivers); },
  createDriver: (body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/drivers`, body).then((r) => r.data.driver); },
  assignDriver: (orderId: string, body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/orders/${orderId}/assign-driver`, body).then((r) => r.data.assignment); },
  liveDeliveries: () => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/delivery-assignments/live`).then((r) => r.data.assignments); },
  // Delivery fulfilment board (2026-09-04)
  fulfilmentBoard: (): Promise<FulfilmentOrder[]> => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/fulfilment/board`).then((r) => r.data.orders as FulfilmentOrder[]); },
  fulfilmentTransition: (orderId: string, body: FulfilmentTransitionBody): Promise<FulfilmentOrder> => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/fulfilment/${orderId}/transition`, body).then((r) => r.data.order as FulfilmentOrder); },
  // Site + WhatsApp
  getSite: () => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/site`).then((r) => r.data.site); },
  updateSite: (body: any) => { const b = getBusinessCache(); return api.put(`/businesses/${b.id}/site`, body).then((r) => r.data.site); },
  listCampaigns: () => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/wa/campaigns`).then((r) => r.data.campaigns); },
  createCampaign: (body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/wa/campaigns`, body).then((r) => r.data.campaign); },
  runCampaign: (id: string) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/wa/campaigns/${id}/run`).then((r) => r.data); },
  // Accounting exports
  exportTally: (body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/exports/tally`, body, { responseType: 'text' }).then((r) => r.data); },
  exportZoho: (body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/exports/zoho`, body, { responseType: 'text' }).then((r) => r.data); },
  generateEinvoice: (orderId: string) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/einvoice/${orderId}`).then((r) => r.data.irn); },
  // Multi-outlet
  listOutletGroups: () => api.get('/outlet-groups').then((r) => r.data.groups),
  createOutletGroup: (body: any) => api.post('/outlet-groups', body).then((r) => r.data.group),
  outletRollup: (groupId: string, params: { startDate?: string; endDate?: string }): Promise<OutletRollup> =>
    api.get(`/outlet-groups/${groupId}/rollup`, { params }).then((r) => r.data.rollup),
  // Outlet switcher feed — ungated, every tenant gets at least their own row.
  myOutlets: (): Promise<MyOutlet[]> =>
    api.get('/outlet-groups/my-outlets').then((r) => r.data.outlets),
  // Owner-only + gated on the `multi_outlet` feature → 402 FEATURE_LOCKED
  // when the plan/addon doesn't include it (the caller shows the upsell).
  provisionOutlet: (body: { name: string; label?: string; city?: string }): Promise<ProvisionOutletResult> =>
    api.post('/outlet-groups/outlets/provision', body).then((r) => r.data),
  // Trades the current session for one scoped to `businessId`. The shared
  // axios instance already carries `X-Auth-Mode: cookie` + withCredentials,
  // so a cookie session stays a cookie session across the switch.
  switchBusiness: (businessId: string): Promise<SwitchBusinessResult> =>
    api.post('/auth/switch-business', { businessId }).then((r) => r.data),
  // Deleting an outlet is HQ-owner-only and email-OTP verified (2 steps).
  requestOutletDeleteOtp: (businessId: string): Promise<{
    requestId: string; sentTo: string; expiresAt: string;
  }> =>
    api.post(`/outlet-groups/outlets/${businessId}/delete/request-otp`).then((r) => r.data),
  deleteOutlet: (businessId: string, requestId: string, code: string): Promise<{
    deleted: boolean; businessId: string;
  }> =>
    api.post(`/outlet-groups/outlets/${businessId}/delete`, { requestId, code })
       .then((r) => r.data),
  // Retail
  listRetailItems: (params?: any) => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/retail/items`, { params }).then((r) => r.data.items); },
  createRetailItem: (body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/retail/items`, body).then((r) => r.data.item); },
  findRetailByBarcode: (barcode: string) => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/retail/barcode/${barcode}`).then((r) => r.data.item); },
  bulkImportRetail: (rows: any[]) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/retail/bulk-import`, { rows }).then((r) => r.data); },
  listVendors: () => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/retail/vendors`).then((r) => r.data.vendors); },
  createVendor: (body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/retail/vendors`, body).then((r) => r.data.vendor); },
  createPO: (body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/retail/purchase-orders`, body).then((r) => r.data.po); },
  receivePO: (poId: string, body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/retail/purchase-orders/${poId}/receive`, body).then((r) => r.data.grn); },
  recordCheque: (body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/retail/cheques`, body).then((r) => r.data.cheque); },

  // ── Final-100 endpoints ────────────────────────────────────────────────
  splitBill: (sessionId: string, body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/sessions/${sessionId}/split`, body).then((r) => r.data.split); },
  paySplitInvoice: (id: string, paymentMethod: string) => { const b = getBusinessCache(); return api.put(`/businesses/${b.id}/bill-split-invoices/${id}/pay`, { paymentMethod }).then((r) => r.data.invoice); },
  listFoodCoupons: () => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/food-coupons`).then((r) => r.data.coupons); },
  applyFoodCoupon: (body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/food-coupons/apply`, body).then((r) => r.data); },
  listReviews: (params?: any) => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/reviews`, { params }).then((r) => r.data.reviews); },
  reviewStats: () => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/reviews/stats`).then((r) => r.data.stats); },
  replyReview: (id: string, reply: string) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/reviews/${id}/reply`, { reply }).then((r) => r.data.review); },
  forecast: (date?: string) => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/forecast`, { params: { date } }).then((r) => r.data.forecast); },
  refreshForecast: () => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/forecast/refresh`).then((r) => r.data); },
  upsellFor: (menuItemId: string) => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/upsell/${menuItemId}`).then((r) => r.data.suggestions); },
  seedCoa: () => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/accounting/seed-coa`).then((r) => r.data); },
  trialBalance: (asOf?: string) => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/accounting/trial-balance`, { params: { asOf } }).then((r) => r.data.tb); },
  profitAndLoss: (params: any) => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/accounting/profit-loss`, { params }).then((r) => r.data.pnl); },
  balanceSheet: (asOf?: string) => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/accounting/balance-sheet`, { params: { asOf } }).then((r) => r.data.bs); },
  listSurgeRules: () => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/surge/rules`).then((r) => r.data.rules); },
  createSurgeRule: (body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/surge/rules`, body).then((r) => r.data.rule); },
  updateSurgeRule: (id: string, body: any) => { const b = getBusinessCache(); return api.put(`/businesses/${b.id}/surge/rules/${id}`, body).then((r) => r.data.rule); },
  deleteSurgeRule: (id: string) => { const b = getBusinessCache(); return api.delete(`/businesses/${b.id}/surge/rules/${id}`).then((r) => r.data); },
  pollKds: (stationId: string, since?: string) => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/kds/${stationId}/poll`, { params: { since } }).then((r) => r.data.tickets); },
  markKdsTicket: (ticketId: string, status: string) => { const b = getBusinessCache(); return api.put(`/businesses/${b.id}/kds/tickets/${ticketId}/status`, { status }).then((r) => r.data.ticket); },
  importBank: (body: any) => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/bank/import`, body).then((r) => r.data); },
  autoMatchBank: () => { const b = getBusinessCache(); return api.post(`/businesses/${b.id}/bank/auto-match`).then((r) => r.data); },
  unmatchedBank: () => { const b = getBusinessCache(); return api.get(`/businesses/${b.id}/bank/unmatched`).then((r) => r.data.rows); },

  // Expenses
  listExpenses: (params: any = {}) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/expenses`, { params }).then((r) => r.data.expenses);
  },
  // NP-128 — paged variant: returns { expenses, count, total } for
  // server-side pagination (mirrors listOrdersPaged).
  listExpensesPaged: (params: any = {}) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/expenses`, { params }).then((r) => r.data);
  },
  createExpense: (body: any) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/expenses`, body).then((r) => r.data.expense);
  },
  deleteExpense: (id: string) => {
    const b = getBusinessCache();
    return api.delete(`/businesses/${b.id}/expenses/${id}`).then((r) => r.data);
  },

  // Reports
  dailyReport: (date: string) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/reports/daily`, { params: { date } }).then((r) => r.data.report);
  },
  monthlyReport: (month: string) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/reports/monthly`, { params: { month } }).then((r) => r.data.report);
  },
  // Push 15 — Schedule III income statement (P&L) with exports
  incomeStatement: (startDate: string, endDate: string) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/reports/income-statement`,
      { params: { startDate, endDate } }).then((r) => r.data.report);
  },
  // Download an export. Auth is via the same Bearer header axios adds, so
  // we go through axios instead of an <a href> (which wouldn't include
  // the token). Triggers a save-as in the browser via a blob URL.
  downloadIncomeStatement: async (format: 'pdf' | 'xlsx' | 'csv',
                                  startDate: string, endDate: string) => {
    const b = getBusinessCache();
    const r = await api.get(
      `/businesses/${b.id}/reports/income-statement.${format}`,
      { params: { startDate, endDate }, responseType: 'blob' }
    );
    _triggerBlobDownload(r.data, `pnl_${startDate}_${endDate}.${format}`);
  },

  // Push 15h — register detail reports (Income / Expense / Invoices)
  incomeRegister: (startDate: string, endDate: string) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/reports/income-register`,
      { params: { startDate, endDate } }).then((r) => r.data.report);
  },
  downloadIncomeRegister: async (format: 'pdf' | 'xlsx' | 'csv',
                                 startDate: string, endDate: string) => {
    const b = getBusinessCache();
    const r = await api.get(
      `/businesses/${b.id}/reports/income-register.${format}`,
      { params: { startDate, endDate }, responseType: 'blob' }
    );
    _triggerBlobDownload(r.data, `income_register_${startDate}_${endDate}.${format}`);
  },
  expenseRegister: (startDate: string, endDate: string) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/reports/expense-register`,
      { params: { startDate, endDate } }).then((r) => r.data.report);
  },
  downloadExpenseRegister: async (format: 'pdf' | 'xlsx' | 'csv',
                                  startDate: string, endDate: string) => {
    const b = getBusinessCache();
    const r = await api.get(
      `/businesses/${b.id}/reports/expense-register.${format}`,
      { params: { startDate, endDate }, responseType: 'blob' }
    );
    _triggerBlobDownload(r.data, `expense_register_${startDate}_${endDate}.${format}`);
  },
  invoiceRegister: (startDate: string, endDate: string) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/reports/invoice-register`,
      { params: { startDate, endDate } }).then((r) => r.data.report);
  },
  downloadInvoiceRegister: async (format: 'pdf' | 'xlsx' | 'csv',
                                  startDate: string, endDate: string) => {
    const b = getBusinessCache();
    const r = await api.get(
      `/businesses/${b.id}/reports/invoice-register.${format}`,
      { params: { startDate, endDate }, responseType: 'blob' }
    );
    _triggerBlobDownload(r.data, `invoice_register_${startDate}_${endDate}.${format}`);
  },
  // NP-106 — GSTR-1 / GSTR-3B CSVs. These used to be opened via
  // window.open(), which can't attach the Authorization header, so the
  // auth-gated route always 401'd (and the browser saved the JSON error
  // body as a .csv). Fetch through axios as a blob like the register
  // exports above. NOTE: the backend reads `from`/`to` here, not
  // startDate/endDate (see sprintsAll.routes.js).
  downloadGstr: async (report: 'gstr1' | 'gstr3b', from: string, to: string) => {
    const b = getBusinessCache();
    const r = await api.get(
      `/businesses/${b.id}/reports/${report}.csv`,
      { params: { from, to }, responseType: 'blob' }
    );
    _triggerBlobDownload(r.data, `${report}_${from}_${to}.csv`);
  },
  // Push 15c — Tax invoices (GST Rule 46)
  listTaxInvoices: (params: { startDate?: string; endDate?: string; status?: string } = {}) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/tax-invoices`, { params })
      .then((r) => r.data.invoices);
  },
  issueTaxInvoice: (body: any) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/tax-invoices`, body)
      .then((r) => r.data.invoice);
  },
  getTaxInvoice: (invoiceId: string) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/tax-invoices/${invoiceId}`)
      .then((r) => r.data.invoice);
  },
  downloadTaxInvoicePdf: async (invoiceId: string, invoiceNo?: string) => {
    const b = getBusinessCache();
    const r = await api.get(
      `/businesses/${b.id}/tax-invoices/${invoiceId}/pdf`,
      { responseType: 'blob' }
    );
    const safe = (invoiceNo || invoiceId).replace(/[/\\]/g, '_');
    _triggerBlobDownload(r.data, `tax_invoice_${safe}.pdf`);
  },
  // Returns a blob URL the caller is responsible for revoking — useful
  // for opening a print preview in a new tab (window.open(url)).
  taxInvoicePrintBlobUrl: async (invoiceId: string) => {
    const b = getBusinessCache();
    const r = await api.get(
      `/businesses/${b.id}/tax-invoices/${invoiceId}/pdf`,
      { responseType: 'blob' }
    );
    return URL.createObjectURL(r.data as Blob);
  },
  cancelTaxInvoice: (invoiceId: string, reason?: string) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/tax-invoices/${invoiceId}/cancel`, { reason })
      .then((r) => r.data.invoice);
  },

  // Staff
  listStaff: () => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/staff`).then((r) => r.data.members);
  },
  listInvites: () => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/staff/invites`).then((r) => r.data.invitations);
  },
  inviteStaff: (email: string, role: string) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/staff/invites`, { email, role }).then((r) => r.data);
  },
  removeStaff: (userId: string) => {
    const b = getBusinessCache();
    return api.delete(`/businesses/${b.id}/staff/${userId}`).then((r) => r.data);
  },

  // Push 14a — direct PIN-based staff CRUD (no email invite required).
  listStaffPin: () => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/staff/pin`).then((r) => r.data.staff);
  },
  createStaffPin: (body: any) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/staff/pin`, body).then((r) => r.data.staff);
  },
  updateStaffPin: (userId: string, patch: any) => {
    const b = getBusinessCache();
    return api.put(`/businesses/${b.id}/staff/pin/${userId}`, patch).then((r) => r.data.staff);
  },
  // Push 14e — auto-comply with plan limit. Deactivates excess non-owner
  // staff (newest hires) until active count matches plan.limits.staff.
  complyStaffLimit: () => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/staff/pin/comply-limit`).then((r) => r.data);
  },

  // Billing
  //
  // 2026-09-04: the response's `subscription` now also carries `usage` (the
  // owner-facing plan-limit meter) and `grace` (the past-due grace notice).
  // Both are nested inside `subscription` server-side precisely so this call
  // shape — and the mobile app's identical one — did not have to change.
  subscription: (): Promise<Subscription | null> => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/billing`).then((r) => r.data.subscription);
  },
  plans: () => api.get('/plans').then((r) => r.data.plans),
  // FF-402c — cadence is now a sibling arg (plan tier is one row that
  // carries both prices). Backend picks the right Razorpay plan id
  // and price based on billingPeriod.
  changePlan: (tier: string, billingPeriod?: 'monthly' | 'yearly') => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/billing/change`, { tier, billingPeriod }).then((r) => r.data);
  },
  cancelSubscription: () => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/billing/cancel`).then((r) => r.data);
  },
  // ── Cancel flow / pause / export (2026-09-05, churn batch) ─────────────
  //
  // Cancelling is three calls, not one: reasons → survey (which returns the
  // offer) → cancel. `cancelSubscription` above is unchanged and still works
  // on its own, so a client that has not been updated keeps cancelling.
  cancelReasons: (): Promise<CancelReason[]> => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/billing/cancel/reasons`).then((r) => r.data.reasons);
  },
  cancelSurvey: (reason: string, note?: string): Promise<CancelSurveyResult> => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/billing/cancel/survey`, { reason, note })
      .then((r) => r.data);
  },
  pauseSubscription: (months: 1 | 2 | 3, reason?: string) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/billing/pause`, { months, reason })
      .then((r) => r.data);
  },
  resumeSubscription: () => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/billing/resume`).then((r) => r.data);
  },
  // The owner's own data as a downloadable file. Deliberately not plan-gated
  // server-side — see churnService.exportAccount.
  exportAccount: (): Promise<Blob> => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/billing/export`, { responseType: 'blob' })
      .then((r) => r.data as Blob);
  },

  invoices: () => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/billing/invoices`).then((r) => r.data.invoices);
  },
  // 2026-08-26 — GST-compliant subscription invoice PDF, generated on demand.
  subscriptionInvoicePdf: (invoiceId: string) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/billing/invoices/${invoiceId}/pdf`,
      { responseType: 'blob' }).then((r) => r.data as Blob);
  },

  // Support / ticketing (X7 tenant side)
  supportTickets: () => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/support`).then((r) => r.data.tickets);
  },
  supportTicket: (id: string) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/support/${id}`).then((r) => r.data.ticket);
  },
  createSupportTicket: (body: { subject: string; priority?: string; body: string }) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/support`, body).then((r) => r.data.ticket);
  },
  replySupportTicket: (id: string, body: string) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/support/${id}/messages`, { body }).then((r) => r.data.ticket);
  },

  // Referral program (L2 / FF-333 tenant side)
  referral: () => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/referral`).then((r) => r.data);
  },

  // Add-on marketplace
  catalogAddons: () => api.get('/addons').then((r) => r.data.addons),
  myAddons: () => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/addons`).then((r) => r.data);
  },
  subscribeAddon: (slug: string) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/addons/subscribe`, { slug }).then((r) => r.data);
  },
  cancelAddon: (slug: string) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/addons/${slug}/cancel`).then((r) => r.data);
  },
  resumeAddon: (slug: string) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/addons/${slug}/resume`).then((r) => r.data);
  },

  // ── Loyalty / CRM ──────────────────────────────────────────────────────
  listCustomers: (params: any = {}) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/customers`, { params }).then((r) => r.data);
  },
  customerDetail: (customerId: string) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/customers/${customerId}`).then((r) => r.data);
  },
  lookupCustomer: (phone: string) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/customers/lookup`, { params: { phone } }).then((r) => r.data);
  },
  upsertCustomer: (body: any) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/customers`, body).then((r) => r.data.customer);
  },
  updateCustomer: (customerId: string, patch: any) => {
    const b = getBusinessCache();
    return api.patch(`/businesses/${b.id}/customers/${customerId}`, patch).then((r) => r.data.customer);
  },
  adjustPoints: (customerId: string, points: number, note?: string) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/customers/${customerId}/points`, { points, note }).then((r) => r.data);
  },
  getLoyaltySettings: () => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/customers/_settings/loyalty`).then((r) => r.data.settings);
  },
  updateLoyaltySettings: (body: any) => {
    const b = getBusinessCache();
    return api.put(`/businesses/${b.id}/customers/_settings/loyalty`, body).then((r) => r.data.settings);
  },

  // ── KOT + Tables (Sprint 2) ─────────────────────────────────────────────
  // Stations
  listStations: () => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/ops/kot/stations`).then((r) => r.data.stations);
  },
  createStation: (body: any) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/ops/kot/stations`, body).then((r) => r.data.station);
  },
  updateStation: (id: string, body: any) => {
    const b = getBusinessCache();
    return api.put(`/businesses/${b.id}/ops/kot/stations/${id}`, body).then((r) => r.data.station);
  },
  deleteStation: (id: string) => {
    const b = getBusinessCache();
    return api.delete(`/businesses/${b.id}/ops/kot/stations/${id}`).then((r) => r.data);
  },
  // Tickets
  listTickets: (params: any = {}) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/ops/kot/tickets`, { params }).then((r) => r.data.tickets);
  },
  updateTicketStatus: (id: string, status: string) => {
    const b = getBusinessCache();
    return api.put(`/businesses/${b.id}/ops/kot/tickets/${id}/status`, { status }).then((r) => r.data.ticket);
  },
  // Floors
  listFloors: () => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/ops/floors`).then((r) => r.data.floors);
  },
  createFloor: (body: any) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/ops/floors`, body).then((r) => r.data.floor);
  },
  updateFloor: (id: string, body: any) => {
    const b = getBusinessCache();
    return api.put(`/businesses/${b.id}/ops/floors/${id}`, body).then((r) => r.data.floor);
  },
  deleteFloor: (id: string) => {
    const b = getBusinessCache();
    return api.delete(`/businesses/${b.id}/ops/floors/${id}`).then((r) => r.data);
  },
  // Tables
  listOpsTables: (floorId?: string) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/ops/tables`, { params: floorId ? { floorId } : {} }).then((r) => r.data.tables);
  },
  createOpsTable: (body: any) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/ops/tables`, body).then((r) => r.data.table);
  },
  updateOpsTable: (id: string, body: any) => {
    const b = getBusinessCache();
    return api.put(`/businesses/${b.id}/ops/tables/${id}`, body).then((r) => r.data.table);
  },
  deleteOpsTable: (id: string) => {
    const b = getBusinessCache();
    return api.delete(`/businesses/${b.id}/ops/tables/${id}`).then((r) => r.data);
  },
  // Sessions
  openSession: (tableId: string, body: any) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/ops/tables/${tableId}/sessions`, body).then((r) => r.data.session);
  },
  closeSession: (sessionId: string, paymentMethod?: string) => {
    const b = getBusinessCache();
    return api
      .post(`/businesses/${b.id}/ops/sessions/${sessionId}/close`, { paymentMethod })
      .then((r) => r.data.session);
  },
  // Push 22 — release a table whose customer left without ordering.
  // Refuses if any non-cancelled orders are attached.
  abandonSession: (sessionId: string) => {
    const b = getBusinessCache();
    return api
      .post(`/businesses/${b.id}/ops/sessions/${sessionId}/abandon`)
      .then((r) => r.data.session);
  },
  sessionDetail: (sessionId: string) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/ops/sessions/${sessionId}`).then((r) => r.data.session);
  },

  // ── QR ordering (Sprint 3) ─────────────────────────────────────────────
  qrSettings: () => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/ops/qr/settings`).then((r) => r.data.settings);
  },
  updateQrSettings: (body: any) => {
    const b = getBusinessCache();
    return api.put(`/businesses/${b.id}/ops/qr/settings`, body).then((r) => r.data.settings);
  },
  qrTokenForTable: (tableId: string) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/ops/tables/${tableId}/qr`)
      .then((r) => {
        if (!r.data?.token) {
          // eslint-disable-next-line no-console
          console.warn('[qrTokenForTable] backend returned no token:', r.data);
          throw new Error('No QR token returned by server');
        }
        return r.data.token as string;
      })
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.error('[qrTokenForTable] failed for table', tableId, e?.response?.status, e?.response?.data || e?.message);
        throw e;
      });
  },
  rotateQrToken: (tableId: string) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/ops/tables/${tableId}/qr/rotate`).then((r) => r.data.token);
  },

  // ── Ingredients & recipes (Sprint 4) ───────────────────────────────────
  listIngredients: (params: any = {}) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/ingredients`, { params }).then((r) => r.data.ingredients);
  },
  createIngredient: (body: any) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/ingredients`, body).then((r) => r.data.ingredient);
  },
  updateIngredient: (id: string, body: any) => {
    const b = getBusinessCache();
    return api.patch(`/businesses/${b.id}/ingredients/${id}`, body).then((r) => r.data.ingredient);
  },
  deleteIngredient: (id: string) => {
    const b = getBusinessCache();
    return api.delete(`/businesses/${b.id}/ingredients/${id}`).then((r) => r.data);
  },
  purchaseIngredient: (id: string, body: any) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/ingredients/${id}/purchase`, body).then((r) => r.data.ingredient);
  },
  adjustIngredient: (id: string, body: any) => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/ingredients/${id}/adjust`, body).then((r) => r.data.ingredient);
  },
  getRecipe: (menuItemId: string) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/ingredients/_recipes/${menuItemId}`).then((r) => r.data.lines);
  },
  setRecipe: (menuItemId: string, lines: any[]) => {
    const b = getBusinessCache();
    return api.put(`/businesses/${b.id}/ingredients/_recipes/${menuItemId}`, { lines }).then((r) => r.data.lines);
  },
  foodCostReport: (params: any = {}) => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/ingredients/_report/food-cost`, { params }).then((r) => r.data.report);
  },

  // ── DPDP compliance ────────────────────────────────────────────────
  // Append-only consent record. Backend writes a new consent_events
  // row every time; never updates an existing one.
  recordConsent: (body: {
    consentKey: string;
    granted: boolean;
    policyVersion?: string;
    source?: string;
    context?: Record<string, unknown>;
  }) => api.post('/me/consents', { source: 'dashboard', ...body }).then((r) => r.data),
  currentConsents: () => api.get('/me/consents').then((r) => r.data.consents),
  consentHistory: () => api.get('/me/consents/history').then((r) => r.data.history),
  fileDsr: (body: { requestType: string; details?: Record<string, unknown> }) =>
    api.post('/me/dsr', body).then((r) => r.data),
  listMyDsrs: () => api.get('/me/dsr').then((r) => r.data.requests),
  fileCorrection: (body: { field: string; newValue: unknown; reason?: string }) =>
    api.post('/me/correct', body).then((r) => r.data),
  exportMyData: () => api.get('/me/export').then((r) => r.data),
  eraseMyAccount: () => api.delete('/me/account').then((r) => r.data),

  // ── Round 2 (2026-09-06) — B2B template / recurring invoices / API keys /
  // white label. Shapes per CONTRACTS_round2.md §1–§4. All tenant-scoped.
  getB2BInvoiceTemplate: (): Promise<B2BInvoiceTemplate> => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/b2b-invoice-template`).then((r) => r.data.template);
  },
  updateB2BInvoiceTemplate: (body: Partial<B2BInvoiceTemplate>): Promise<B2BInvoiceTemplate> => {
    const b = getBusinessCache();
    return api.put(`/businesses/${b.id}/b2b-invoice-template`, body).then((r) => r.data.template);
  },

  listRecurringInvoices: (): Promise<RecurringSchedule[]> => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/recurring-invoices`).then((r) => r.data.schedules);
  },
  createRecurringInvoice: (body: RecurringScheduleBody): Promise<RecurringSchedule> => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/recurring-invoices`, body).then((r) => r.data.schedule);
  },
  updateRecurringInvoice: (
    id: string, patch: Partial<RecurringScheduleBody> & { isActive?: boolean },
  ): Promise<RecurringSchedule> => {
    const b = getBusinessCache();
    return api.patch(`/businesses/${b.id}/recurring-invoices/${id}`, patch).then((r) => r.data.schedule);
  },
  deleteRecurringInvoice: (id: string): Promise<void> => {
    const b = getBusinessCache();
    return api.delete(`/businesses/${b.id}/recurring-invoices/${id}`).then(() => undefined);
  },
  runRecurringInvoiceNow: (id: string): Promise<RecurringRunNowResult> => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/recurring-invoices/${id}/run-now`).then((r) => r.data);
  },

  listApiKeys: (): Promise<ApiKeyRow[]> => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/api-keys`).then((r) => r.data.keys);
  },
  createApiKey: (label: string): Promise<ApiKeyCreated> => {
    const b = getBusinessCache();
    return api.post(`/businesses/${b.id}/api-keys`, { label }).then((r) => r.data);
  },
  revokeApiKey: (keyId: string): Promise<void> => {
    const b = getBusinessCache();
    return api.delete(`/businesses/${b.id}/api-keys/${keyId}`).then(() => undefined);
  },

  getWhiteLabel: (): Promise<WhiteLabel> => {
    const b = getBusinessCache();
    return api.get(`/businesses/${b.id}/white-label`).then((r) => r.data.whiteLabel);
  },
  updateWhiteLabel: (body: Partial<WhiteLabel>): Promise<WhiteLabel> => {
    const b = getBusinessCache();
    return api.put(`/businesses/${b.id}/white-label`, body).then((r) => r.data.whiteLabel);
  },

  // Public — no auth
  grievanceOfficer: () => api.get('/compliance/grievance-officer').then((r) => r.data),
  fileGrievance: (body: {
    businessId?: string;
    complainantName?: string;
    complainantEmail?: string;
    complainantPhone?: string;
    category?: string;
    subject: string;
    body: string;
  }) => api.post('/compliance/grievance', body).then((r) => r.data),
};
