// NamastePOS admin - typed API client (super-admin surface)

import { api } from './client';

// ── Types ────────────────────────────────────────────────────────────────
export interface Admin {
  id: string; email: string; displayName?: string;
  role: 'super_admin' | 'finance' | 'support' | 'sales';
  isActive: boolean; lastLoginAt?: string; createdAt: string;
}

// 2026-09-03 — multi-outlet visibility. An outlet is its own `businesses` row
// linked by outlet_group_id; the group's HQ is outlet_groups.parent_business_id.
// null on the Customer means "standalone single-outlet business".
export interface OutletInfo {
  groupId: string;
  groupName: string | null;
  isParent: boolean;        // this business IS the group's HQ
  siblingCount: number;     // other businesses in the group
  parentBusinessId: string | null;
  parentName: string | null;
  label: string | null;     // short branch name, e.g. "Andheri West"
}

export interface OutletSibling {
  id: string; name: string; label: string | null;
  city: string | null; isParent: boolean;
}

export interface Customer {
  id: string; name: string; email: string; phone?: string;
  city?: string; category?: string; createdAt: string;
  plan: { tier: string; name: string; priceInr: number } | null;
  subscriptionStatus: string;
  currentPeriodEnd?: string;
  cancelAtPeriodEnd: boolean;
  totalOrders: number;
  totalRevenue: number;
  staffCount: number;
  // FF-402 — CRM primitives cached on businesses.
  lifecycleStage?: 'trial' | 'active' | 'at_risk' | 'churned' | null;
  healthScore?: number | null;
  outlet?: OutletInfo | null;
}

// ── Tenant-privacy shapes (2026-09-03) ──────────────────────────────────
// The customer drilldown no longer returns the tenant's order ledger. Support
// gets AGGREGATES only. Do not add per-order fields here — the server does not
// send them and re-adding the UI would just invite someone to re-add the query.
export interface OrderStats {
  orderCount: number;
  cancelledCount: number;
  grossVolumeInr: number;
  avgTicketInr: number;
  firstOrderAt: string | null;
  lastOrderAt: string | null;
  revenueByMonth: { month: string; orders: number; revenueInr: number }[];
}

// One tenant order, super-admin only, audit-logged, diner PII masked.
export interface SupportOrder {
  id: string; orderNo: number; status: string; source: string;
  subtotal: number | null; tax: number | null; discount: number | null;
  total: number | null;
  paymentMethod: string | null; cancelReason: string | null;
  createdAt: string; updatedAt: string;
  diner: { initials: string | null; phoneLast4: string | null };
  items: { name: string; qty: number; price: number | null; note: string | null }[];
  privacyNotice: string;
}

/**
 * One rung of the tier-kind ladder, served by GET /admin/tier-kinds.
 * `rank` is the ladder index (0 = lowest); `label` is owner-facing
 * ('pro_plan' -> 'Pro'). See adminApi.tierKinds.
 */
export interface TierKindOption {
  kind: string;
  rank: number;
  label: string;
}

export interface Plan {
  id: string;
  // Push 18a — tier is now a free-form code (was an enum locked to
  // free/basic/pro). Any [a-z0-9_]+ string is allowed. It is a CODE, not a
  // name: live mapping is free=Starter, basic=Growth, pro_plan=Pro,
  // advanced=Advanced, pro=Enterprise (yes, tier 'pro' is Enterprise).
  tier: string;
  name: string;
  // A tier KIND, not a code, and the list is open-ended — the ladder comes
  // from GET /admin/tier-kinds. Do NOT narrow this to a union of literals:
  // it was typed 'starter'|'pro'|'enterprise' and silently mistyped the live
  // 'pro_plan' and 'advanced' plans.
  tierKind?: string;
  priceInr: number; priceInrPaise: number;
  // FF-402c — one plan, two prices. null yearly = plan doesn't offer yearly.
  priceYearlyInr: number | null;
  priceYearlyInrPaise: number | null;
  billingPeriod?: string;    // deprecated at plan level, still returned for legacy readers
  razorpayPlanId?: string | null;
  razorpayPlanIdYearly?: string | null;
  isActive: boolean;
  limits: Record<string, number>;
  features: Record<string, any>;
  // Custom (per-customer) plans: is_public=false + linked business. The admin
  // list endpoint may or may not return them — code defensively.
  isPublic?: boolean;
  businessId?: string | null;
}

export interface Coupon {
  id: string; code: string; description?: string;
  type: 'percent' | 'flat' | 'trial_extension';
  value: number;
  appliesToPlan?: string | null;
  // 2026-08-25: scope fields so the admin can distinguish platform
  // subscription coupons (the only kind now listed) from tenant food coupons.
  appliesTo?: 'subscription' | 'food_order' | 'both';
  businessId?: string | null;
  maxRedemptions?: number | null;
  redemptionCount: number;
  startsAt: string; expiresAt?: string;
  status: 'active' | 'disabled' | 'expired';
  createdAt: string;
}

export interface Refund {
  id: string; businessId: string; businessName?: string;
  paymentId?: string; invoiceId?: string;
  amount: number; amountPaise: number; currency: string;
  reason?: string; status: 'pending' | 'processed' | 'failed' | 'cancelled';
  razorpayRefundId?: string;
  adminEmail?: string;
  createdAt: string; processedAt?: string;
}

export interface Setting { key: string; value: any; description?: string; }

export interface AuditEvent {
  id: string; module: string; action: string;
  entityType?: string; entityId?: string;
  adminEmail?: string; businessName?: string;
  payload: any; ipAddress?: string;
  createdAt: string;
}

export interface Metrics {
  totalBusinesses: number;
  subscriptionsByStatus: Record<string, number>;
  businessesByPlan: Record<string, number>;
  mrrInr: number;
  arrInr: number;
  signups30d: { date: string; count: number }[];
  orders30d: number;
  gmv30dInr: number;
}

// ── Platform ops (2026-09-03 — SaaS control plane) ──────────────────────

export interface AttentionItem {
  kind: 'past_due' | 'stuck_refund' | 'expiring_addon' | 'p1_ticket' | 'trial_ending';
  severity: 'critical' | 'high' | 'medium' | 'low';
  businessId: string | null;
  businessName: string | null;
  label: string;
  detail: string | null;
  at: string | null;
}

export interface Overview {
  mrrInr: number;
  arrInr: number;
  counts: {
    customers: number; active: number; trialing: number; pastDue: number;
    paused: number; cancelled: number; signups7d: number; signups30d: number;
    churned30d: number; openTickets: number; p1Tickets: number;
    failedPayments24h: number; pendingRefunds: number; orders30d: number;
  };
  revenue: {
    thisMonthInr: number; lastMonthInr: number;
    refundsThisMonthInr: number; gmv30dInr: number;
  };
  addons: {
    activeActivations: number; tenantsWithAddon: number;
    liveTenants: number; attachRatePct: number;
  };
  plans: { tier: string; name: string; count: number }[];
  signupTrend: { date: string; count: number }[];
  mrrTrend: { month: string; inr: number }[];
  needsAttention: AttentionItem[];
}

export interface UsageMetric {
  metric: string;
  used: number;
  limit: number;          // -1 = unlimited
  unlimited: boolean;
  utilisationPct: number | null;
  over: boolean;
  near: boolean;
}
export interface UsageRow {
  businessId: string;
  businessName: string;
  subscriptionStatus: string | null;
  planTier: string | null;
  planName: string | null;
  metrics: UsageMetric[];
  overLimitCount: number;
  nearLimitCount: number;
  maxUtilisationPct: number;
}

export interface DunningRow {
  subscriptionId: string;
  businessId: string;
  businessName: string;
  businessEmail: string | null;
  accountOwnerEmail: string | null;
  status: string;
  dunningAttempts: number;
  lastDunningAt: string | null;
  currentPeriodEnd: string | null;
  billingPeriod: string;
  razorpaySubscriptionId: string | null;
  planTier: string | null;
  planName: string | null;
  amountAtRiskInr: number;
  lifetimeFailures: number;
}
export interface DunningEvent {
  id: string;
  event: string;
  attemptNo: number | null;
  reason: string | null;
  emailed: boolean;
  at: string;
}

export interface NotificationRow {
  id: string;
  channel: 'email';
  template: string;
  recipient: string;
  subject: string;
  status: 'queued' | 'sent' | 'failed' | 'suppressed' | string;
  providerId: string | null;
  error: string | null;
  createdAt: string;
  sentAt: string | null;
  userEmail: string | null;
}

export interface CronJobStat {
  at: string; ms: number; ok: boolean; error: string | null;
}
export interface PlatformHealth {
  api: { ok: boolean; env: string; uptimeSec: number };
  db: { ok: boolean; latencyMs: number | null; error: string | null; connections: number | null };
  redis: { configured: boolean; ready: boolean; mode: string };
  migrations: { applied: number | null; lastAppliedAt: string | null };
  webhooks: {
    received24h: number | null; errored24h: number | null;
    unprocessed24h: number | null; lastEventAt: string | null;
  };
  cron: {
    running: boolean; startedAt: string | null; lastTickAt: string | null;
    lastTickMs: number | null; ticks: number; skippedTicks: number;
    jobs: Record<string, CronJobStat>;
  };
}

// ── Endpoints ────────────────────────────────────────────────────────────
export const adminApi = {
  // Login may return either a token (no 2FA) or a 2FA challenge for enrolled
  // admins. The caller must handle both shapes.
  // 2026-09-04: these no longer return an access token. The session is the
  // httpOnly ff_admin cookie the response sets; the body only carries the
  // flow signal (`authenticated` / `requires2fa` / `mustEnrol2fa`).
  login: (email: string, password: string) =>
    api.post<{ authenticated?: boolean; admin?: Admin; requires2fa?: boolean; challengeId?: string; mustEnrol2fa?: boolean }>(
      '/admin/auth/login', { email, password }).then((r) => r.data),
  // Complete a 2FA-gated login → sets the session cookie.
  verify2fa: (challengeId: string, code: string) =>
    api.post<{ authenticated: boolean; admin: Admin }>('/admin/auth/2fa/verify', { challengeId, code })
       .then((r) => r.data),
  // 2FA enrolment (current admin). Start returns the otpauth URI + one-time
  // recovery codes; confirm activates it; disable requires a current code.
  enrol2faStart: () =>
    api.post<{ otpauth: string; secret: string; recoveryCodes: string[] }>('/admin/auth/2fa/enrol')
       .then((r) => r.data),
  enrol2faConfirm: (code: string) =>
    api.post<{ enrolled: boolean; authenticated?: boolean }>('/admin/auth/2fa/enrol/confirm', { code })
       .then((r) => r.data),
  disable2fa: (code: string) =>
    api.post<{ disabled: boolean }>('/admin/auth/2fa/disable', { code }).then((r) => r.data),
  me: () => api.get<{ admin: Admin }>('/admin/auth/me').then((r) => r.data.admin),

  // Admin team
  teamList: () => api.get<{ admins: Admin[] }>('/admin/team').then((r) => r.data.admins),
  teamCreate: (body: { email: string; password: string; displayName?: string; role?: string }) =>
    api.post<{ admin: Admin }>('/admin/team', body).then((r) => r.data.admin),
  teamUpdate: (id: string, body: any) =>
    api.patch<{ admin: Admin }>(`/admin/team/${id}`, body).then((r) => r.data.admin),
  teamDeactivate: (id: string) => api.delete(`/admin/team/${id}`).then((r) => r.data),

  // Customers
  listCustomers: (params: any = {}) =>
    api.get<{ customers: Customer[]; total: number; limit: number; offset: number }>(
      '/admin/customers', { params }).then((r) => r.data),
  getCustomer: (id: string) =>
    api.get<{ customer: any }>(`/admin/customers/${id}`).then((r) => r.data.customer),
  drilldown: (id: string) =>
    api.get<any>(`/admin/customers/${id}/drilldown`).then((r) => r.data),

  // TENANT PRIVACY (2026-09-03): the one admin path to a single tenant order.
  // 403 for anyone who is not super_admin, diner PII masked server-side, and
  // every call lands in the audit log. There is deliberately NO list/search
  // counterpart — the order id has to come from the ticket.
  customerOrder: (businessId: string, orderId: string, reason?: string) =>
    api.get<{ order: SupportOrder }>(
      `/admin/customers/${businessId}/order/${orderId}`,
      { params: reason ? { reason } : undefined },
    ).then((r) => r.data.order),

  // GST-compliant subscription invoice PDF — generated on demand by the
  // backend and returned as a blob so we can open it with the admin's auth.
  invoicePdf: (businessId: string, invoiceId: string) =>
    api.get(`/admin/customers/${businessId}/invoices/${invoiceId}/pdf`, {
      responseType: 'blob',
    }).then((r) => r.data as Blob),
  createCustomer: (body: any) =>
    api.post<{ business: any }>('/admin/customers', body).then((r) => r.data.business),
  updateCustomer: (id: string, body: any) =>
    api.patch<{ business: any }>(`/admin/customers/${id}`, body).then((r) => r.data.business),
  deleteCustomer: (id: string) => api.delete(`/admin/customers/${id}`).then((r) => r.data),
  suspend: (id: string) => api.post(`/admin/customers/${id}/suspend`).then((r) => r.data),
  restore: (id: string) => api.post(`/admin/customers/${id}/restore`).then((r) => r.data),
  extendTrial: (id: string, days: number) =>
    api.post(`/admin/customers/${id}/extend-trial`, { days }).then((r) => r.data),
  // FF-402c — cadence is a separate param now; plan tier is one row.
  setPlan: (id: string, tier: string, billingPeriod?: 'monthly' | 'yearly') =>
    api.post(`/admin/customers/${id}/set-plan`, { tier, billingPeriod }).then((r) => r.data),
  impersonate: (id: string) =>
    api.post<{ accessToken: string; business: any }>(`/admin/customers/${id}/impersonate`).then((r) => r.data),
  // NP-126 — one-time impersonation code. The dashboard exchanges it via
  // POST /v1/auth/impersonation-exchange for a real session, so no raw JWT
  // ever rides in a URL, in browser history, or on the clipboard.
  impersonationCode: (id: string) =>
    api.post<{ code: string }>(`/admin/customers/${id}/impersonation-code`).then((r) => r.data),
  addNote: (id: string, body: string, pinned = false) =>
    api.post<{ note: any }>(`/admin/customers/${id}/notes`, { body, pinned }).then((r) => r.data.note),
  deleteNote: (id: string, noteId: string) =>
    api.delete(`/admin/customers/${id}/notes/${noteId}`).then((r) => r.data),

  // ── Customer lifecycle (2026-09-03) ──────────────────────────────────
  // `immediate: false` (the default) keeps service until the paid period
  // ends and cancels the gateway mandate at cycle end.
  cancelSubscription: (id: string, body: { immediate?: boolean; reason?: string } = {}) =>
    api.post<{ subscription: any }>(`/admin/customers/${id}/cancel-subscription`, body)
       .then((r) => r.data.subscription),
  changeOwnerEmail: (id: string, email: string) =>
    api.post<{ business: any }>(`/admin/customers/${id}/owner-email`, { email })
       .then((r) => r.data.business),
  // NamastePOS has no password-reset link (owners use Google Sign-In); this
  // clears the owner's MPIN + lockout and revokes live sessions.
  resetOwnerCredentials: (id: string) =>
    api.post<{ mpinCleared: boolean; sessionsRevoked: number }>(
      `/admin/customers/${id}/reset-owner-credentials`).then((r) => r.data),
  resendWelcome: (id: string) =>
    api.post<{ recipient: string; status: string }>(`/admin/customers/${id}/resend-welcome`)
       .then((r) => r.data),
  setAccountFields: (id: string, body: {
    accountOwnerEmail?: string | null;
    tags?: string[];
    lifecycleStage?: 'trial' | 'active' | 'at_risk' | 'churned' | null;
  }) =>
    api.patch<{ business: any }>(`/admin/customers/${id}/account`, body)
       .then((r) => r.data.business),
  anonymiseCustomer: (id: string, reason: string) =>
    api.post(`/admin/customers/${id}/anonymise`, { confirm: 'ANONYMISE', reason })
       .then((r) => r.data),

  // Usage vs plan limits + platform → tenant email log
  customerUsage: (id: string) =>
    api.get<{ usage: UsageRow }>(`/admin/customers/${id}/usage`).then((r) => r.data.usage),
  customerNotifications: (id: string, params: { limit?: number; offset?: number; status?: string } = {}) =>
    api.get<{ channel: string; rows: NotificationRow[]; total: number }>(
      `/admin/customers/${id}/notifications`, { params }).then((r) => r.data),

  // Plans
  listPlans: () => api.get<{ plans: Plan[] }>('/admin/plans').then((r) => r.data.plans),
  updatePlan: (tier: string, patch: any) =>
    api.put<{ plan: Plan }>(`/admin/plans/${tier}`, patch).then((r) => r.data.plan),
  createPlan: (body: any) =>
    api.post<{ plan: Plan }>('/admin/plans', body).then((r) => r.data.plan),
  deletePlan: (tier: string) =>
    api.delete(`/admin/plans/${tier}`).then((r) => r.data),
  syncRazorpay: () => api.post('/admin/razorpay/sync').then((r) => r.data),
  // 2026-09-04 — the tier_kind ladder comes FROM THE BACKEND (single source
  // of truth: namastepos_backend/src/services/planTiers.js). This page used
  // to hardcode ['starter','pro','enterprise'], which had drifted from the
  // live five-kind ladder: the Pro and Advanced plans rendered a blank
  // "Tier kind" select and could not be created at all. Never re-add a
  // local list — render the picker from this call.
  tierKinds: () =>
    api.get<{ tierKinds: TierKindOption[] }>('/admin/tier-kinds').then((r) => r.data.tierKinds),

  // Push 14d — feature matrix (source of truth for plan-gated UI on the
  // owner dashboard + mobile). Changes propagate within ~60s as those
  // clients poll /auth/me.
  featureCatalog: () =>
    api.get<{ features: string[] }>('/admin/feature-catalog').then((r) => r.data.features),
  tierFeatures: (tierKind: string) =>
    api.get<{ features: string[] }>(`/admin/tier-features/${tierKind}`).then((r) => r.data.features),
  setTierFeatures: (tierKind: string, features: string[]) =>
    api.put<{ features: string[] }>(`/admin/tier-features/${tierKind}`, { features }).then((r) => r.data.features),

  // Coupons
  listCoupons: (params: any = {}) =>
    api.get<{ coupons: Coupon[] }>('/admin/coupons', { params }).then((r) => r.data.coupons),
  createCoupon: (body: any) =>
    api.post<{ coupon: Coupon }>('/admin/coupons', body).then((r) => r.data.coupon),
  updateCoupon: (id: string, body: any) =>
    api.patch<{ coupon: Coupon }>(`/admin/coupons/${id}`, body).then((r) => r.data.coupon),
  disableCoupon: (id: string) =>
    api.post<{ coupon: Coupon }>(`/admin/coupons/${id}/disable`).then((r) => r.data.coupon),
  couponRedemptions: (id: string) =>
    api.get(`/admin/coupons/${id}/redemptions`).then((r) => r.data.redemptions),

  // Refunds
  listRefunds: (params: any = {}) =>
    api.get<{ refunds: Refund[] }>('/admin/refunds', { params }).then((r) => r.data.refunds),
  initiateRefund: (body: {
    paymentId: string; amountPaise?: number; reason?: string;
    // Optional context so the refund also lands on the tenant's CRM timeline.
    businessId?: string | null; orderId?: string | null;
  }) =>
    api.post<{ refund: Refund }>('/admin/refunds', body).then((r) => r.data.refund),

  // Settings
  listSettings: () => api.get<{ settings: Setting[] }>('/admin/settings').then((r) => r.data.settings),
  saveSettings: (kv: Record<string, any>) =>
    api.put<{ settings: Setting[] }>('/admin/settings', kv).then((r) => r.data.settings),

  // GST
  gstSummary: (month: string) =>
    api.get<{ summary: any }>('/admin/gst/summary', { params: { month } }).then((r) => r.data.summary),
  // NP-107: fetch the CSV through the shared axios instance so cookie auth
  // (ff_admin cookie + CSRF interceptor) works — the old raw-URL path sent no
  // credentials and saved the 401 JSON body as a .csv. Axios rejects on
  // non-2xx, so callers never save an error body.
  gstr1Csv: (month: string) =>
    api.get<Blob>('/admin/gst/gstr1.csv', { params: { month }, responseType: 'blob' })
      .then((r) => r.data),
  gstr3b: (month: string) =>
    api.get('/admin/gst/gstr3b', { params: { month } }).then((r) => r.data.gstr3b),
  // Push 19d — HSN-wise summary + B2B/B2C split
  gstHsn: (month: string) =>
    api.get('/admin/gst/hsn', { params: { month } }).then((r) => r.data),
  gstB2bB2c: (month: string) =>
    api.get('/admin/gst/b2b-b2c', { params: { month } }).then((r) => r.data),

  // Reports
  cohorts: (months = 6) => api.get('/admin/reports/cohorts', { params: { months } }).then((r) => r.data.cohorts),
  funnel: (days = 30) => api.get('/admin/reports/funnel', { params: { days } }).then((r) => r.data.funnel),
  ltv: () => api.get('/admin/reports/ltv').then((r) => r.data),
  churn: () => api.get('/admin/reports/churn').then((r) => r.data),
  topItems: (days = 30, limit = 10) =>
    api.get('/admin/reports/top-items', { params: { days, limit } }).then((r) => r.data.topItems),
  topCities: (days = 30, limit = 15) =>
    api.get('/admin/reports/top-cities', { params: { days, limit } }).then((r) => r.data.topCities),
  mrrTrend: (months = 12) =>
    api.get('/admin/reports/mrr-trend', { params: { months } }).then((r) => r.data.series),
  // Push 19e — outstanding invoices + aging buckets
  outstanding: () =>
    api.get('/admin/reports/outstanding').then((r) => r.data),
  // N4 — consolidated subscription ledger (all tenants + summary)
  subscriptions: (params: { status?: string; billingMode?: string } = {}) =>
    api.get('/admin/reports/subscriptions', { params }).then((r) => r.data),

  // X7 — support / ticketing
  // NP-143: paginated — returns { tickets, total } (limit default 50, max 200).
  supportTickets: (params: { status?: string; limit?: number; offset?: number } = {}) =>
    api.get('/admin/support/tickets', { params }).then((r) => r.data),
  supportTicket: (id: string) =>
    api.get(`/admin/support/tickets/${id}`).then((r) => r.data.ticket),
  supportCreateTicket: (body: { businessId: string; subject: string; priority?: string; body: string }) =>
    api.post('/admin/support/tickets', body).then((r) => r.data.ticket),
  supportReply: (id: string, body: string) =>
    api.post(`/admin/support/tickets/${id}/messages`, { body }).then((r) => r.data.ticket),
  supportSetStatus: (id: string, status: string) =>
    api.patch(`/admin/support/tickets/${id}/status`, { status }).then((r) => r.data.ticket),

  // X4 — tenant broadcast
  broadcastPreview: (segment: string) =>
    api.get('/admin/broadcast/preview', { params: { segment } }).then((r) => r.data),
  broadcastSend: (body: { segment: string; subject: string; body: string }) =>
    api.post('/admin/broadcast/send', body).then((r) => r.data),

  // Tenant audit trail (owner/staff money mutations)
  tenantAudit: (businessId: string) =>
    api.get(`/admin/customers/${businessId}/audit`).then((r) => r.data.events),

  // L2 — referrals
  referrals: (params: { status?: string } = {}) =>
    api.get('/admin/referrals', { params }).then((r) => r.data.referrals),
  referralReward: (id: string, note?: string) =>
    api.post(`/admin/referrals/${id}/reward`, { note }).then((r) => r.data.referral),
  // L5 — add-on partner payouts
  addonPayouts: () => api.get('/admin/reports/addon-payouts').then((r) => r.data),
  // Push 20d — platform consolidated P&L, customer KPIs, revenue breakdown
  pnl: (params: { from?: string; to?: string } = {}) =>
    api.get('/admin/reports/pnl', { params }).then((r) => r.data),
  customersKpi: () =>
    api.get('/admin/reports/customers-kpi').then((r) => r.data),
  revenueBreakdown: (months = 12) =>
    api.get('/admin/reports/revenue-breakdown', { params: { months } }).then((r) => r.data.series),

  // ── DPDP / Compliance (super-admin console) ──────────────────────────
  complianceDsr: (params: { status?: string; limit?: number } = {}) =>
    api.get<{ requests: Dsr[] }>('/admin/compliance/dsr', { params }).then((r) => r.data.requests),
  updateDsr: (id: string, body: { status: string; note?: string; proofHash?: string }) =>
    api.patch<Dsr>(`/admin/compliance/dsr/${id}`, body).then((r) => r.data),
  complianceGrievances: (params: { status?: string; businessId?: string; limit?: number } = {}) =>
    api.get<{ grievances: Grievance[] }>('/admin/compliance/grievances', { params }).then((r) => r.data.grievances),
  updateGrievance: (id: string, body: { status: string; resolutionNote?: string }) =>
    api.patch<{ id: string; status: string }>(`/admin/compliance/grievances/${id}`, body).then((r) => r.data),
  complianceBreaches: (params: { status?: string; limit?: number } = {}) =>
    api.get<{ breaches: Breach[] }>('/admin/compliance/breaches', { params }).then((r) => r.data.breaches),
  logBreach: (body: {
    scope?: string; businessId?: string | null; occurredAt?: string | null;
    category: string; severity: string; affectedCount?: number | null;
    dataCategories?: string[]; summary: string; rootCause?: string; remediation?: string;
  }) => api.post('/admin/compliance/breaches', body).then((r) => r.data),
  updateBreach: (id: string, body: { status?: string; fields?: Record<string, any> }) =>
    api.patch(`/admin/compliance/breaches/${id}`, body).then((r) => r.data),
  complianceSettings: () =>
    api.get<ComplianceSettings>('/admin/compliance/settings').then((r) => r.data),
  saveComplianceSettings: (body: Record<string, any>) =>
    api.put<ComplianceSettings>('/admin/compliance/settings', body).then((r) => r.data),
  retentionConfig: () =>
    api.get<RetentionConfig>('/admin/compliance/retention').then((r) => r.data),
  saveRetention: (body: Partial<Pick<RetentionConfig, 'deletedBusinessDays' | 'auditLogDays' | 'cookieConsentDays'>>) =>
    api.put<RetentionConfig>('/admin/compliance/retention', body).then((r) => r.data),
  previewRetention: () =>
    api.get<RetentionPreview>('/admin/compliance/retention/preview').then((r) => r.data),
  runRetention: () =>
    api.post<RetentionRun>('/admin/compliance/retention/run').then((r) => r.data),

  // Audit + ops
  auditLog: (params: any = {}) =>
    api.get<{ events: AuditEvent[] }>('/admin/audit', { params }).then((r) => r.data.events),
  webhookEvents: () => api.get('/admin/webhooks/events').then((r) => r.data.events),
  dbHealth: () => api.get('/admin/health/db').then((r) => r.data),

  // Headline metrics
  metrics: () => api.get<Metrics>('/admin/metrics').then((r) => r.data),

  // ── Platform ops (2026-09-03) ────────────────────────────────────────
  // One aggregate call behind the admin home page.
  overview: () => api.get<Overview>('/admin/overview').then((r) => r.data),
  platformHealth: () => api.get<PlatformHealth>('/admin/health/platform').then((r) => r.data),
  platformUsage: (params: { overLimitOnly?: boolean; limit?: number; offset?: number } = {}) =>
    api.get<{ rows: UsageRow[]; total: number; limit: number; offset: number }>(
      '/admin/reports/usage', { params }).then((r) => r.data),

  // Dunning / billing ops — reads are revenue.read, actions are revenue.write
  // (finance + super_admin only), and every action is audited server-side.
  dunningQueue: (params: { includeRecovered?: boolean; limit?: number } = {}) =>
    api.get<{ rows: DunningRow[]; summary: { count: number; amountAtRiskInr: number; atRiskOfChurn: number } }>(
      '/admin/dunning', { params }).then((r) => r.data),
  dunningTimeline: (businessId: string) =>
    api.get<{ events: DunningEvent[] }>(`/admin/dunning/${businessId}/timeline`)
       .then((r) => r.data.events),
  dunningRetry: (businessId: string) =>
    api.post<{ emailed: boolean; attemptNo: number; recipient: string | null }>(
      `/admin/dunning/${businessId}/retry`).then((r) => r.data),
  dunningWaive: (businessId: string, reason: string) =>
    api.post<{ subscription: any }>(`/admin/dunning/${businessId}/waive`, { reason })
       .then((r) => r.data.subscription),
  dunningMarkPaid: (businessId: string, body: { amountPaise?: number; reference?: string } = {}) =>
    api.post<{ invoice: any }>(`/admin/dunning/${businessId}/mark-paid`, body).then((r) => r.data),

  // ── FF-402 CRM primitives ────────────────────────────────────────────
  crmActivities: (businessId: string, params: { limit?: number; kind?: string } = {}) =>
    api.get<{ activities: any[] }>(`/admin/customers/${businessId}/crm/activities`, { params })
       .then((r) => r.data.activities),
  crmAddActivity: (businessId: string, body: { kind?: string; title: string; body?: string; meta?: any }) =>
    api.post(`/admin/customers/${businessId}/crm/activities`, body).then((r) => r.data),
  crmRecomputeHealth: (businessId: string) =>
    api.post<{ health: { score: number; stage: string; lastOrderDays: number; lastLoginDays: number } }>(
      `/admin/customers/${businessId}/crm/recompute-health`).then((r) => r.data.health),
  crmRecomputeAllHealth: () =>
    api.post<{ count: number }>('/admin/crm/recompute-all-health').then((r) => r.data),
  crmListTasks: (params: { businessId?: string; ownerEmail?: string; openOnly?: boolean } = {}) =>
    api.get<{ tasks: any[] }>('/admin/crm/tasks', { params }).then((r) => r.data.tasks),
  crmCreateTask: (body: { businessId?: string | null; title: string; notes?: string; ownerEmail?: string; dueAt?: string | null }) =>
    api.post<{ task: any }>('/admin/crm/tasks', body).then((r) => r.data.task),
  crmCompleteTask: (taskId: string) =>
    api.post<{ task: any }>(`/admin/crm/tasks/${taskId}/complete`).then((r) => r.data.task),
  crmRenewals: (days = 7) =>
    api.get<{ items: any[] }>('/admin/crm/renewals', { params: { days } }).then((r) => r.data.items),

  // ── Add-ons (marketplace catalog) ─────────────────────────────────────
  listAddons:    () => api.get<{ addons: Addon[] }>('/admin/addons').then((r) => r.data.addons),
  createAddon:   (body: any) => api.post<{ addon: Addon }>('/admin/addons', body).then((r) => r.data.addon),
  updateAddon:   (slug: string, body: any) =>
                   api.put<{ addon: Addon }>(`/admin/addons/${slug}`, body).then((r) => r.data.addon),
  syncAddonsRzp: () => api.post('/admin/addons/sync-razorpay').then((r) => r.data),
  // Push 19b — attach/detach an addon for a customer (super-admin).
  attachAddonToCustomer: (businessId: string, slug: string) =>
    api.post(`/admin/customers/${businessId}/addons/${slug}/attach`).then((r) => r.data),
  detachAddonFromCustomer: (businessId: string, slug: string) =>
    api.post(`/admin/customers/${businessId}/addons/${slug}/detach`).then((r) => r.data),
  customerAddons: (id: string) =>
                   api.get<{ addons: any[] }>(`/admin/customers/${id}/addons`).then((r) => r.data.addons),
  // Push 20b — bulk menu import (CSV parsed client-side into JSON items[])
  bulkImportMenu: (businessId: string, items: any[]) =>
    api.post<{ inserted: number; skipped: number; errors: Array<{ row: number; name?: string; message: string }> }>(
      `/admin/customers/${businessId}/menu/bulk`, { items }
    ).then((r) => r.data),

  // ── Custom plans + feature overrides (plans-addons migration) ─────────
  // Global feature-key catalog. The backend may return {keys:[{key,label?}]}
  // OR a plain string array — normalise both to FeatureKey[] here so pages
  // never have to care.
  // FIX 2026-09-03: pointed at a non-existent /admin/feature-keys — the custom
  // plan feature picker and the overrides dropdown both rendered empty
  // ("No feature keys available"). The real endpoint is /admin/feature-catalog
  // → { features: string[] }.
  listFeatureKeys: () =>
    api.get<any>('/admin/feature-catalog').then((r) => {
      const raw = Array.isArray(r.data)
        ? r.data
        : (r.data?.features ?? r.data?.keys ?? []);
      return (raw as any[]).map((k): FeatureKey =>
        typeof k === 'string' ? { key: k } : { key: k.key, label: k.label });
    }),
  getFeatureOverrides: (businessId: string) =>
    api.get<{ overrides: FeatureOverride[] }>(`/admin/customers/${businessId}/feature-overrides`)
       .then((r) => r.data.overrides ?? []),
  // PUT replaces the whole set.
  setFeatureOverrides: (businessId: string, overrides: FeatureOverride[]) =>
    api.put<{ overrides: FeatureOverride[] }>(`/admin/customers/${businessId}/feature-overrides`, { overrides })
       .then((r) => r.data.overrides ?? []),
  deleteFeatureOverride: (businessId: string, featureKey: string) =>
    api.delete(`/admin/customers/${businessId}/feature-overrides/${featureKey}`).then((r) => r.data),
  // {plan:null} when the customer has no custom plan yet.
  getCustomPlan: (businessId: string) =>
    api.get<CustomPlanResponse>(`/admin/customers/${businessId}/custom-plan`).then((r) => r.data),
  saveCustomPlan: (businessId: string, body: CustomPlanInput) =>
    api.put<CustomPlanResponse>(`/admin/customers/${businessId}/custom-plan`, body).then((r) => r.data),
  // 409 when the plan is currently assigned to the customer.
  // force=true → backend moves the customer back to the base plan (or free)
  // before deleting, so removal works even while the plan is assigned.
  deleteCustomPlan: (businessId: string, force = false) =>
    api.delete(`/admin/customers/${businessId}/custom-plan${force ? '?force=true' : ''}`)
       .then((r) => r.data),
};

// ── DPDP / Compliance ──────────────────────────────────────────────────
export interface Dsr {
  id: string; userId: string | null; businessId: string | null;
  guestPhone: string | null; contactEmail: string | null;
  requestType: 'access' | 'correction' | 'erasure' | 'portability' | 'withdraw_consent';
  status: 'pending' | 'in_review' | 'completed' | 'rejected' | 'partial';
  details: any; source: string;
  slaDueAt: string | null; respondedAt: string | null; closedAt: string | null;
  handledBy: string | null; proofHash: string | null;
  createdAt: string; updatedAt: string;
}
export interface Grievance {
  id: string; businessId: string | null; userId: string | null;
  complainantName: string | null; complainantEmail: string | null; complainantPhone: string | null;
  category: string; subject: string; body: string;
  status: 'received' | 'acknowledged' | 'resolved' | 'rejected' | 'escalated';
  acknowledgedAt: string | null; resolvedAt: string | null; resolutionNote: string | null;
  handledBy: string | null; ackDueAt: string | null; resolveDueAt: string | null;
  createdAt: string; updatedAt: string;
}
export interface Breach {
  id: string; scope: string; business_id: string | null; occurred_at: string | null;
  category: string; severity: 'low' | 'medium' | 'high' | 'critical';
  affected_count: number | null; data_categories: string[]; summary: string;
  root_cause: string | null; remediation: string | null;
  status: 'detected' | 'triaging' | 'contained' | 'notified' | 'closed';
  detected_at: string; dpb_notified_at: string | null; cert_in_notified_at: string | null;
  users_notified_at: string | null; ack_ref: string | null;
  created_by: string | null; created_at: string; updated_at: string;
}
export interface ComplianceSettings {
  grievanceOfficer: { name?: string; email?: string; phone?: string; address?: string };
  dataProtectionOfficer: { name?: string; email?: string };
  legalEntity: { name?: string; address?: string; cin?: string; gstin?: string };
  privacyPolicyVersion?: string; termsOfServiceVersion?: string; updatedAt?: string;
}
export interface RetentionRun {
  businessesPurged: number; auditRowsPruned: number; consentRowsPruned: number; ranAt: string;
}
export interface RetentionConfig {
  deletedBusinessDays: number; auditLogDays: number; cookieConsentDays: number;
  lastRun: RetentionRun | null;
}
export interface RetentionPreview {
  config: RetentionConfig;
  businessesEligible: number; auditRowsEligible: number; consentRowsEligible: number;
}

// ── Custom plans + feature overrides ───────────────────────────────────
export interface FeatureKey { key: string; label?: string }
export interface FeatureOverride { featureKey: string; mode: 'enable' | 'disable' }
export interface CustomPlanLimits {
  staff: number; tables: number; floors: number;
  menu_items: number; monthly_orders: number;
}
export interface CustomPlan {
  tier: string; name: string;
  priceInrPaise: number; priceYearlyPaise: number | null;
  limits: CustomPlanLimits;
  // A tier KIND from the open-ended ladder (GET /admin/tier-kinds), NOT a
  // union of literals: typed 'starter'|'pro'|'enterprise' it mistyped the
  // live 'pro_plan' and 'advanced' kinds. See src/hooks/useTierKinds.ts.
  tierKind: string;
  assigned: boolean;
  // 2026-09-03 — "base plan + extras": the public plan this one extends,
  // the extras layered on top, and the base's keys (shown locked in the UI).
  basePlanTier?: string | null;
  extraFeatureKeys?: string[];
  inheritedFeatureKeys?: string[];
  featureKeys?: string[];   // effective = inherited ∪ extras
}
export interface CustomPlanResponse { plan: CustomPlan | null; featureKeys?: string[] }
export interface CustomPlanInput {
  name: string;
  basePlanTier?: string | null;
  priceInrPaise?: number;
  priceYearlyPaise?: number | null;
  limits?: CustomPlanLimits;
  extraFeatureKeys?: string[];
  featureKeys?: string[];    // legacy flat list — treated as extras
  // A tier KIND from the open-ended ladder (GET /admin/tier-kinds). Required
  // by the backend when basePlanTier is absent (a standalone custom plan).
  tierKind?: string;
  assign: boolean;
}

export interface Addon {
  id: string; slug: string; name: string;
  tagline?: string; description?: string;
  icon: string; category: 'integrations' | 'marketing' | 'operations' | 'reports';
  priceInr: number; priceInrPaise: number;
  billingPeriod: string;
  requiredPlanTier?: string | null;
  trialDays: number;
  features: { permissions?: string[]; limits?: Record<string, number> };
  razorpayPlanId?: string;
  isActive: boolean;
  displayOrder: number;
}
