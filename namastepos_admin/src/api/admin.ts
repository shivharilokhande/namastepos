// NamastePOS admin - typed API client (super-admin surface)

import { api } from './client';

// ── Types ────────────────────────────────────────────────────────────────
export interface Admin {
  id: string; email: string; displayName?: string;
  role: 'super_admin' | 'finance' | 'support' | 'sales';
  isActive: boolean; lastLoginAt?: string; createdAt: string;
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
}

export interface Plan {
  id: string;
  // Push 18a — tier is now a free-form code (was an enum locked to
  // free/basic/pro). Any [a-z0-9_]+ string is allowed.
  tier: string;
  name: string;
  tierKind?: 'starter' | 'pro' | 'enterprise';
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

// ── Endpoints ────────────────────────────────────────────────────────────
export const adminApi = {
  // Login may return either a token (no 2FA) or a 2FA challenge for enrolled
  // admins. The caller must handle both shapes.
  login: (email: string, password: string) =>
    api.post<{ token?: string; admin?: Admin; requires2fa?: boolean; challengeId?: string }>(
      '/admin/auth/login', { email, password }).then((r) => r.data),
  // Complete a 2FA-gated login → returns the real access token.
  verify2fa: (challengeId: string, code: string) =>
    api.post<{ token: string; admin: Admin }>('/admin/auth/2fa/verify', { challengeId, code })
       .then((r) => r.data),
  // 2FA enrolment (current admin). Start returns the otpauth URI + one-time
  // recovery codes; confirm activates it; disable requires a current code.
  enrol2faStart: () =>
    api.post<{ otpauth: string; secret: string; recoveryCodes: string[] }>('/admin/auth/2fa/enrol')
       .then((r) => r.data),
  enrol2faConfirm: (code: string) =>
    api.post<{ enrolled: boolean }>('/admin/auth/2fa/enrol/confirm', { code }).then((r) => r.data),
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
  addNote: (id: string, body: string, pinned = false) =>
    api.post<{ note: any }>(`/admin/customers/${id}/notes`, { body, pinned }).then((r) => r.data.note),
  deleteNote: (id: string, noteId: string) =>
    api.delete(`/admin/customers/${id}/notes/${noteId}`).then((r) => r.data),

  // Plans
  listPlans: () => api.get<{ plans: Plan[] }>('/admin/plans').then((r) => r.data.plans),
  updatePlan: (tier: string, patch: any) =>
    api.put<{ plan: Plan }>(`/admin/plans/${tier}`, patch).then((r) => r.data.plan),
  createPlan: (body: any) =>
    api.post<{ plan: Plan }>('/admin/plans', body).then((r) => r.data.plan),
  deletePlan: (tier: string) =>
    api.delete(`/admin/plans/${tier}`).then((r) => r.data),
  syncRazorpay: () => api.post('/admin/razorpay/sync').then((r) => r.data),

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
  gstr1CsvUrl: (month: string) =>
    `${(api.defaults.baseURL || '').replace(/\/v1$/, '/v1')}/admin/gst/gstr1.csv?month=${month}`,
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
  supportTickets: (params: { status?: string } = {}) =>
    api.get('/admin/support/tickets', { params }).then((r) => r.data.tickets),
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
  // Push 20d — platform consolidated P&L, customer KPIs, revenue breakdown
  pnl: (params: { from?: string; to?: string } = {}) =>
    api.get('/admin/reports/pnl', { params }).then((r) => r.data),
  customersKpi: () =>
    api.get('/admin/reports/customers-kpi').then((r) => r.data),
  revenueBreakdown: (months = 12) =>
    api.get('/admin/reports/revenue-breakdown', { params: { months } }).then((r) => r.data.series),

  // Audit + ops
  auditLog: (params: any = {}) =>
    api.get<{ events: AuditEvent[] }>('/admin/audit', { params }).then((r) => r.data.events),
  webhookEvents: () => api.get('/admin/webhooks/events').then((r) => r.data.events),
  dbHealth: () => api.get('/admin/health/db').then((r) => r.data),

  // Headline metrics
  metrics: () => api.get<Metrics>('/admin/metrics').then((r) => r.data),

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
};

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
