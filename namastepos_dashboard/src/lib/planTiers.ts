// The plan tier-kind ladder, mirrored for the owner dashboard.
//
// SINGLE SOURCE OF TRUTH is namastepos_backend/src/services/planTiers.js
// (TIER_KIND_LADDER). This file is a display-only mirror: the dashboard
// receives a tenant's `tierKind` from /auth/me and needs a rank + a label to
// render with. It never decides entitlement — every gate is server-side.
// If you add a rung to the backend ladder, add it here too; the backend's
// regression test (tests/integration/plan_tier_ladder.test.js) catches drift
// between the ladder and the database, and this file is the third copy to
// update in that same change.
//
// ══════════════════════════════════════════════════════════════════════════
// A plan has BOTH a tier CODE and a tier KIND, and they collide on 'pro':
//
//   name        | tier (CODE) | tierKind (KIND) | price
//   ------------|-------------|-----------------|-----------
//   Starter     | free        | starter         | Rs 0
//   Growth      | basic       | pro             | Rs 299
//   Pro         | pro_plan    | pro_plan        | Rs 799
//   Advanced    | advanced    | advanced        | Rs 999
//   Enterprise  | pro         | enterprise      | Rs 1,999
//
// So tier === 'pro' is ENTERPRISE while tierKind === 'pro' is GROWTH, and the
// plan named "Pro" is 'pro_plan' in both. Never write a bare tier literal —
// use the helpers below and say which namespace you mean.
// ══════════════════════════════════════════════════════════════════════════

/** Tier kinds from least to most capable. Index = rank. */
export const TIER_KIND_LADDER = [
  'starter',
  'pro',
  'pro_plan',
  'advanced',
  'enterprise',
] as const;

/** Owner-facing name for each kind — what the UI should show. */
export const TIER_KIND_LABELS: Record<string, string> = {
  starter: 'Starter',
  pro: 'Growth',
  pro_plan: 'Pro',
  advanced: 'Advanced',
  enterprise: 'Enterprise',
};

/** Accent colour per kind, used on the billing plan cards. */
export const TIER_KIND_COLORS: Record<string, string> = {
  starter: '#10B981',
  pro: '#FF6B35',
  advanced: '#4F46E5',
  pro_plan: '#0EA5E9',
  enterprise: '#7C3AED',
};

/** One-line "who is this for" per kind, used as the card subtitle. */
export const TIER_KIND_TAGLINES: Record<string, string> = {
  starter: 'Cart / Street vendor',
  pro: 'Cafe / Small restaurant',
  pro_plan: 'Restaurant with a full kitchen',
  advanced: 'Multi-brand / heavy reporting',
  enterprise: 'Hotel / Chain / Multi-outlet',
};

/** Ladder rank of a kind, or null when unknown (e.g. a custom plan). */
export function tierRank(kind: string | undefined | null): number | null {
  if (!kind) return null;
  const i = (TIER_KIND_LADDER as readonly string[]).indexOf(kind);
  return i === -1 ? null : i;
}

/** Owner-facing label, falling back to the raw value. */
export function tierLabel(kind: string | undefined | null): string {
  if (!kind) return '';
  return TIER_KIND_LABELS[kind] ?? kind;
}

/** True when `kind` sits at or above `atLeast` on the ladder. */
export function tierAtLeast(kind: string | undefined | null, atLeast: string): boolean {
  const a = tierRank(kind);
  const b = tierRank(atLeast);
  if (a === null || b === null) return false;
  return a >= b;
}

/** True when `kind` is the top rung — nothing left to upsell. */
export function isTopTier(kind: string | undefined | null): boolean {
  return tierRank(kind) === TIER_KIND_LADDER.length - 1;
}
