// NamastePOS admin — plan / subscription helpers shared across pages (2026-09-06).
// Pure functions + one tiny constant table. No component code here so pages
// can import freely without tripping react-refresh's single-export rule.

import type { Plan } from '@/api/admin';

/**
 * F-02 — does this plan OFFER yearly billing? `priceYearlyInr` is never null for
 * a paid plan (serializePlan defaults it to 10× monthly when the column is
 * NULL, kept for compatibility), so the only truthful signal is `offersYearly`
 * (price_yearly_paise IS NOT NULL). The fallback keeps an older backend that
 * lacks the field behaving exactly as before.
 */
export function planOffersYearly(p: Pick<Plan, 'offersYearly' | 'priceYearlyInr'>): boolean {
  return p.offersYearly ?? (p.priceYearlyInr != null);
}

/**
 * F-07 — the plans an admin may assign / scope to: public, not another tenant's
 * private custom plan, and active. `showAll` (super-admin) lifts the filter for
 * fix-ups. The backend 404s cross-tenant assignment anyway; this is UX.
 */
export function assignablePlans<T extends Pick<Plan, 'isPublic' | 'businessId' | 'isActive'>>(plans: T[], showAll = false): T[] {
  if (showAll) return plans;
  return plans.filter((p) => p.isPublic !== false && !p.businessId && p.isActive !== false);
}

/**
 * subscriptions.status values the console knows. 2026-09-06: `suspended` added —
 * a subscription the platform suspended (mandate cancelled at cycle end; restore
 * of a paid plan returns a checkout). Every status filter / badge uses this.
 */
export const SUBSCRIPTION_STATUSES = [
  { value: 'active', label: 'Active' },
  { value: 'trialing', label: 'Trialing' },
  { value: 'past_due', label: 'Past due' },
  { value: 'paused', label: 'Paused' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'cancelled', label: 'Cancelled' },
] as const;
export type SubscriptionStatus = typeof SUBSCRIPTION_STATUSES[number]['value'];

export type StatusBadgeVariant = 'success' | 'warning' | 'destructive' | 'muted' | 'secondary';
const STATUS_VARIANT: Record<string, StatusBadgeVariant> = {
  active: 'success', trialing: 'warning', past_due: 'destructive',
  paused: 'muted', suspended: 'destructive', cancelled: 'muted',
};
export function subscriptionStatusVariant(status: string | null | undefined): StatusBadgeVariant {
  return STATUS_VARIANT[status ?? ''] ?? 'muted';
}
export function subscriptionStatusLabel(status: string | null | undefined): string {
  return SUBSCRIPTION_STATUSES.find((s) => s.value === status)?.label ?? (status || 'unknown');
}
