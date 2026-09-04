// NamastePOS — SINGLE SOURCE OF TRUTH for plan tier kinds and their rank.
//
// ══════════════════════════════════════════════════════════════════════════
// READ THIS BEFORE YOU TYPE A TIER STRING ANYWHERE. THERE ARE TWO
// NAMESPACES AND THEY OVERLAP ON THE WORD "pro".
// ══════════════════════════════════════════════════════════════════════════
//
// `plans.tier`      = the plan's CODE. Unique, VARCHAR(40) (migration 039).
//                     It is an opaque identifier and historical baggage —
//                     it does NOT read like the plan's marketing name.
// `plans.tier_kind` = the plan's KIND. Its position on the upgrade ladder.
//                     This, and ONLY this, is what eligibility/ranking
//                     compares (see rankOf / compareKinds below).
//
// The live ladder (verify: GET https://api.namastepos.in/v1/public/plans):
//
//   name        | plans.tier (CODE) | plans.tier_kind (KIND) | price
//   ------------|-------------------|------------------------|--------
//   Starter     | free              | starter                | Rs 0
//   Growth      | basic             | pro                    | Rs 299
//   Pro         | pro_plan          | pro_plan               | Rs 799
//   Advanced    | advanced          | advanced               | Rs 999
//   Enterprise  | pro               | enterprise             | Rs 1,999
//
// THE TRAP: the bare string 'pro' is Enterprise's CODE and Growth's KIND.
// The plan actually named "Pro" has the code 'pro_plan'. So:
//   * `WHERE plans.tier = 'pro'`      -> ENTERPRISE  (Rs 1,999)
//   * `WHERE plans.tier_kind = 'pro'` -> GROWTH      (Rs 299)
//   * the plan named Pro              -> 'pro_plan' in BOTH columns
// Two shipped bugs came from this (an addon gate resolving a tier_kind as a
// code, and a feature upsell defaulting to a bogus 'pro'). Never write a
// bare tier literal in application code — import from this module, and if
// you must query a specific plan, say WHICH column you mean.
//
// `plan_features.tier_kind` is a THIRD wrinkle: despite the column name it
// holds a plan tier CODE, not a kind, since migration 040 (see the COMMENT
// ON COLUMN in migration 081 and the mapping note in migration 088).
//
// ADDING A TIER KIND: append it to TIER_KIND_LADDER in rank order and give
// it a label. The admin Joi schemas, the admin UI's picker, addon
// eligibility and the upsell ladder all derive from this array, so nothing
// else needs editing and nothing can drift out of step. The regression test
// tests/integration/plan_tier_ladder.test.js fails if a tier_kind exists in
// the `plans` table that is missing here.

/**
 * Every tier kind, ordered from least to most capable. Index = rank.
 * This array is the source of truth; everything below is derived.
 */
const TIER_KIND_LADDER = Object.freeze([
  // kind        // plan name / plans.tier code / price
  'starter', //     Starter    / 'free'     / Rs 0
  'pro', //         Growth     / 'basic'    / Rs 299
  'pro_plan', //    Pro        / 'pro_plan' / Rs 799
  'advanced', //    Advanced   / 'advanced' / Rs 999
  'enterprise', //  Enterprise / 'pro'      / Rs 1,999
]);

/**
 * Owner-facing name for each kind. Used in 402 upsell copy and the admin
 * picker so nobody has to read 'pro_plan' and guess. Keys must cover
 * TIER_KIND_LADDER exactly (asserted by the regression test).
 */
const TIER_KIND_LABELS = Object.freeze({
  starter: 'Starter',
  pro: 'Growth',
  pro_plan: 'Pro',
  advanced: 'Advanced',
  enterprise: 'Enterprise',
});

/**
 * The live CODE -> KIND mapping, for documentation and for code that has a
 * plan tier code in hand and no plans row to join. Prefer joining `plans`.
 * NOT a validator: super-admin can mint arbitrary codes (migration 039).
 */
const LIVE_PLAN_CODE_TO_KIND = Object.freeze({
  free: 'starter',
  basic: 'pro',
  pro_plan: 'pro_plan',
  advanced: 'advanced',
  pro: 'enterprise',
});

/**
 * Fail-closed default. Used only where a kind is genuinely absent (an
 * unsubscribed tenant, or an internal caller that bypassed validation):
 * the LOWEST rank, so a missing kind can never grant entitlement.
 */
const FALLBACK_TIER_KIND = TIER_KIND_LADDER[0];

/**
 * The bottom kind: free / trial-only, no committed billing. Distinct name
 * from FALLBACK_TIER_KIND (same value today) because the two mean different
 * things — this one is "the free tier", that one is "we don't know".
 */
const STARTER_TIER_KIND = TIER_KIND_LADDER[0];

/**
 * The plan tier CODE an unsubscribed / lapsed tenant resolves to (the free
 * Starter plan). A CODE, not a kind — see the header. Kept here so the one
 * place that hardcodes "which plan do we fall back to" is this module.
 */
const FALLBACK_PLAN_CODE = 'free';

const _RANK = Object.freeze(TIER_KIND_LADDER.reduce((acc, k, i) => {
  acc[k] = i;
  return acc;
}, {}));

/** True when `kind` is a known tier kind. */
function isKnownKind(kind) {
  return typeof kind === 'string' && Object.prototype.hasOwnProperty.call(_RANK, kind);
}

/** Rank of `kind` (0 = lowest), or null when unknown. */
function rankOf(kind) {
  return isKnownKind(kind) ? _RANK[kind] : null;
}

/**
 * Rank for ENTITLEMENT comparisons. An unknown kind ranks LOWEST (fail
 * closed) rather than throwing — a mis-tagged plan must not hand out
 * enterprise addons.
 */
function rankForGate(kind) {
  const r = rankOf(kind);
  return r === null ? 0 : r;
}

/** Negative / 0 / positive, comparing two kinds by rank (fail-closed). */
function compareKinds(a, b) {
  return rankForGate(a) - rankForGate(b);
}

/** True when `currentKind` is at least as capable as `requiredKind`. */
function meetsKind(currentKind, requiredKind) {
  return rankForGate(currentKind) >= rankForGate(requiredKind);
}

/**
 * The next kind up the ladder, or null when there is nowhere to upsell:
 *   - already at the top (enterprise)
 *   - a per-customer custom plan ('custom-<uuid>' tier code) — bespoke
 *     pricing, so a generic upsell would be wrong
 *   - an unknown / missing kind — we do not guess a target (the old code
 *     returned a bare 'pro' here, which pitched Growth (Rs 299) to Pro and
 *     Advanced tenants, i.e. a downgrade sold as an upgrade)
 */
function nextKindUp(kind) {
  if (!kind || String(kind).startsWith('custom-')) return null;
  const r = rankOf(kind);
  if (r === null) return null;
  return r + 1 < TIER_KIND_LADDER.length ? TIER_KIND_LADDER[r + 1] : null;
}

/** Owner-facing label for a kind; falls back to the raw value. */
function labelOf(kind) {
  if (!kind) return null;
  return TIER_KIND_LABELS[kind] || String(kind);
}

/**
 * Back-compat resolver for `addons.required_plan_tier` — the pre-migration-078
 * column, which held a value from the dead `plan_tier` enum (free/basic/pro).
 *
 * Order matters and is deliberately unchanged from migration 078's backfill:
 * interpret the stored value as a KIND first (that is what "requires pro"
 * always meant in the addon admin), and only then fall back to the legacy
 * enum's code mapping. `free` and `basic` both resolve to 'starter' — the
 * conservative choice 078 made; do not "fix" it here without also
 * re-backfilling addons.required_tier_kind, or live addon gates will move.
 *
 * Returns null for an unrecognised value so callers do not block a sale on a
 * guess. `addons.required_tier_kind` is the real source of truth now.
 */
function legacyRequiredPlanTierToKind(code) {
  if (!code) return null;
  const v = String(code);
  if (isKnownKind(v)) return v;
  if (v === 'free' || v === 'basic') return FALLBACK_TIER_KIND;
  return null;
}

module.exports = {
  TIER_KIND_LADDER,
  TIER_KIND_LABELS,
  LIVE_PLAN_CODE_TO_KIND,
  FALLBACK_TIER_KIND,
  STARTER_TIER_KIND,
  FALLBACK_PLAN_CODE,
  isKnownKind,
  rankOf,
  rankForGate,
  compareKinds,
  meetsKind,
  nextKindUp,
  labelOf,
  legacyRequiredPlanTierToKind,
};
