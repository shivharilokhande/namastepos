// NamastePOS backend — ONE definition of "is this subscription entitled?".
//
// WHY THIS FILE EXISTS
// Entitlement used to be an inline SQL condition in featureService.resolveTierKind
// and an implicit assumption everywhere else (subscriptionService.get() joined
// the plan row and handed its limits out regardless of status). Adding a
// past_due grace window by editing those conditions separately would have been
// the "scattered conditionals" failure mode: the feature gate would say
// entitled, the limit gate would disagree, and nobody could tell which was
// right. So the rule lives here exactly once, as a SQL fragment both callers
// interpolate, plus the JS helpers that describe the same rule to clients.
//
// THE RULE
//   entitled ⟺ status = 'active'
//            ∨ (status = 'trialing' ∧ trial not expired)
//            ∨ (status = 'past_due' ∧ within PAST_DUE_GRACE_DAYS of the FIRST
//               failure)
//   Anything else (cancelled, expired trial, past grace) → not entitled, and
//   the caller falls back to the free/starter tier.
//
// GRACE ANCHOR
// `past_due_at` (migration 087), NOT `last_dunning_at`. Every dunning retry
// bumps last_dunning_at, so anchoring there would renew the grace on each
// retry and the window would never close. Legacy rows with a NULL anchor fall
// back to last_dunning_at (backfilled by 087) and, failing that, are treated
// as NOT entitled — fail closed, i.e. exactly the pre-grace behaviour.
//
// CACHE SAFETY
// `entitlementExpiryMs()` returns the instant at which a currently-entitled
// answer stops being true (trial end, or grace end). featureService caps its
// cache TTL at that instant, so neither the in-process Map nor a peer node
// that never receives a Redis invalidation can serve "still in grace" after
// grace has ended. The deadline is derived from the row, so every node
// computes the same one without needing to talk to any other node.

const env = require('../config/env');

/** Grace length in whole days. Clamped to a sane range; never NaN. */
function graceDays() {
  const n = Number(env.PAST_DUE_GRACE_DAYS);
  if (!Number.isFinite(n) || n < 0) return 7;
  return Math.min(Math.floor(n), 365);
}

/**
 * SQL boolean over an aliased `subscriptions` row.
 *
 *   `SELECT ... FROM subscriptions s WHERE ${entitledSql('s')}`
 *
 * The only value interpolated is the grace length, and it comes from
 * `graceDays()` — an integer derived from env and clamped above, never from a
 * request. Nothing user-supplied reaches this string.
 */
function entitledSql(alias = 's') {
  const days = graceDays();
  return `(
    ${alias}.status = 'active'
    OR (${alias}.status = 'trialing'
        AND (${alias}.trial_ends_at IS NULL OR ${alias}.trial_ends_at > NOW()))
    OR (${alias}.status = 'past_due'
        AND ${days} > 0
        AND COALESCE(${alias}.past_due_at, ${alias}.last_dunning_at) IS NOT NULL
        AND COALESCE(${alias}.past_due_at, ${alias}.last_dunning_at)
              + make_interval(days => ${days}) > NOW())
  )`;
}

/** `graceEndsAt` for an aliased row (NULL when there is no anchor). */
function graceEndsAtSql(alias = 's') {
  const days = graceDays();
  return `(COALESCE(${alias}.past_due_at, ${alias}.last_dunning_at)
             + make_interval(days => ${days}))`;
}

// ── JS mirror of the same rule, for rows already in hand ─────────────────

function _ms(v) {
  if (!v) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** The instant a past_due row's grace ends, or null when it has no anchor. */
function graceEndsAt(row) {
  if (!row) return null;
  const anchor = _ms(row.past_due_at) ?? _ms(row.last_dunning_at);
  if (anchor === null) return null;
  const days = graceDays();
  if (days <= 0) return new Date(anchor);
  return new Date(anchor + days * 86_400_000);
}

/**
 * Classify a subscription row.
 *
 * Returns `{ entitled, reason, expiresAt }` where `reason` is one of
 * `active` | `trialing` | `grace` | `trial_expired` | `grace_expired` |
 * `inactive` | `none`, and `expiresAt` is a Date after which the current
 * answer stops holding (null when it never expires on its own).
 */
function classify(row, now = Date.now()) {
  if (!row) return { entitled: false, reason: 'none', expiresAt: null };
  const status = row.status;
  if (status === 'active') {
    return { entitled: true, reason: 'active', expiresAt: null };
  }
  if (status === 'trialing') {
    const ends = _ms(row.trial_ends_at);
    // A trial with no end date is open-ended (admin-comped); it never lapses
    // on its own, which is the pre-existing behaviour of resolveTierKind.
    if (ends === null) return { entitled: true, reason: 'trialing', expiresAt: null };
    if (ends > now) {
      return { entitled: true, reason: 'trialing', expiresAt: new Date(ends) };
    }
    return { entitled: false, reason: 'trial_expired', expiresAt: null };
  }
  if (status === 'past_due') {
    if (graceDays() <= 0) {
      return { entitled: false, reason: 'grace_expired', expiresAt: null };
    }
    const ends = graceEndsAt(row);
    if (!ends) return { entitled: false, reason: 'grace_expired', expiresAt: null };
    if (ends.getTime() > now) {
      return { entitled: true, reason: 'grace', expiresAt: ends };
    }
    return { entitled: false, reason: 'grace_expired', expiresAt: null };
  }
  // 2026-09-05 (churn batch) — a PAUSED subscription is not entitled, which is
  // already the answer `inactive` gives and is exactly what we want: features
  // fall back to the free tier with no parallel entitlement logic anywhere.
  // It is named separately only so callers can say "paused" to the owner
  // instead of the meaningless "inactive". `entitledSql` needs no change —
  // 'paused' is not in its allow-list, so SQL and JS still agree.
  if (status === 'paused') {
    return { entitled: false, reason: 'paused', expiresAt: null };
  }
  return { entitled: false, reason: 'inactive', expiresAt: null };
}

/**
 * Milliseconds-since-epoch at which a currently-entitled row stops being
 * entitled, or null when nothing time-bound applies. featureService uses this
 * to bound its cache TTL.
 */
function entitlementExpiryMs(row, now = Date.now()) {
  const c = classify(row, now);
  return c.expiresAt ? c.expiresAt.getTime() : null;
}

/**
 * Owner-facing description of a grace window. Used by the tenant billing
 * payload so the dashboard banner can state the amount and the exact date
 * access ends instead of a vague "payment problem".
 */
function graceNotice(row, { amountInr = null } = {}) {
  const c = classify(row);
  if (c.reason !== 'grace') return null;
  const endsAt = c.expiresAt;
  const daysLeft = Math.max(0, Math.ceil((endsAt.getTime() - Date.now()) / 86_400_000));
  const amount = amountInr != null && amountInr > 0
    ? `₹${Number(amountInr).toLocaleString('en-IN')}`
    : 'your subscription payment';
  const when = endsAt.toISOString().slice(0, 10);
  return {
    inGrace: true,
    graceEndsAt: endsAt.toISOString(),
    graceDaysLeft: daysLeft,
    graceDays: graceDays(),
    amountInr: amountInr != null ? amountInr : null,
    message: `${amount} could not be collected. Everything keeps working until `
      + `${when} (${daysLeft} day${daysLeft === 1 ? '' : 's'} left). Update your `
      + 'payment method before then and nothing changes.',
  };
}

module.exports = {
  graceDays,
  entitledSql,
  graceEndsAtSql,
  graceEndsAt,
  classify,
  entitlementExpiryMs,
  graceNotice,
};
