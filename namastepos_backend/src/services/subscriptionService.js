// NamastePOS backend - subscription + plan-limit service

const { query } = require('../config/db');
const { Forbidden, NotFound } = require('../utils/errors');
const entitlement = require('./planEntitlement');
// Ordered tier-kind ladder + rank helpers. Single source of truth — read the
// header of that file before touching anything tier-related.
const planTiers = require('./planTiers');

// ── Capped metrics: labels + owner-facing copy ───────────────────────────
//
// 2026-09-04 (pricing audit F-03). The 403 used to read
// "Plan limit reached for monthly_orders: 200/200. Upgrade your plan." — a
// column name and a fraction, shown to a cashier with a queue in front of
// them. These are the same metrics enforceLimit() counts, with words an owner
// can act on. Keys MUST match the metric names in plans.limits.
const METRIC_COPY = {
  monthly_orders: {
    label: 'bills this month',
    noun: 'bills',
    // The one that stops the till. Say what still works and what to do.
    hit: (limit) => `You've used all ${limit} bills included in your plan this month. `
      + 'Billing is paused until you upgrade or the month resets. Upgrading takes '
      + 'about a minute and your bills carry on immediately.',
    warn: (remaining, limit) => `${remaining} of your ${limit} monthly bills left. `
      + 'At zero, the till stops taking orders until you upgrade.',
  },
  menu_items: {
    label: 'menu items',
    noun: 'dishes',
    hit: (limit) => `Your plan covers ${limit} dishes and all ${limit} are in use. `
      + 'Upgrade to add more, or deactivate a dish you no longer sell.',
    warn: (remaining, limit) => `${remaining} of your ${limit} menu items left.`,
  },
  staff: {
    label: 'staff logins',
    noun: 'staff',
    hit: (limit) => `Your plan covers ${limit} staff login${limit === 1 ? '' : 's'} `
      + '(the owner does not count). Upgrade to add another.',
    warn: (remaining, limit) => `${remaining} of your ${limit} staff logins left.`,
  },
  tables: {
    label: 'tables',
    noun: 'tables',
    hit: (limit) => `Your plan covers ${limit} table${limit === 1 ? '' : 's'}. `
      + 'Upgrade to add more seating.',
    warn: (remaining, limit) => `${remaining} of your ${limit} tables left.`,
  },
  floors: {
    label: 'floors',
    noun: 'floors',
    hit: (limit) => `Your plan covers ${limit} floor${limit === 1 ? '' : 's'}. `
      + 'Upgrade to add another seating area.',
    warn: (remaining, limit) => `${remaining} of your ${limit} floors left.`,
  },
};

/** Metrics we can both cap and count. Everything else is data-only. */
const COUNTABLE_METRICS = Object.keys(METRIC_COPY);

function metricLabel(metric) {
  return METRIC_COPY[metric]?.label || String(metric).replace(/_/g, ' ');
}

function limitHitMessage(metric, limit) {
  const c = METRIC_COPY[metric];
  if (c) return c.hit(limit);
  return `Your plan covers ${limit} ${metricLabel(metric)} and you have reached that. `
    + 'Upgrade to continue.';
}

function limitWarnMessage(metric, remaining, limit) {
  const c = METRIC_COPY[metric];
  if (c) return c.warn(remaining, limit);
  return `${remaining} of your ${limit} ${metricLabel(metric)} left.`;
}

/**
 * Count the CURRENT usage of one capped metric. Extracted from enforceLimit
 * (2026-09-04) so the owner-facing usage meter and the gate that blocks them
 * can never disagree about the number — the whole point of the warning is
 * that it predicts the block.
 */
async function currentUsage(businessId, metric) {
  if (metric === 'menu_items') {
    const r = await query(
      `SELECT COUNT(*)::int AS c FROM menu_items
        WHERE business_id = $1 AND is_active = TRUE`,
      [businessId],
    );
    return r.rows[0].c;
  }
  if (metric === 'staff') {
    // Push 14e — owner does NOT count against the staff cap. Starter's
    // "1 staff" means one staff in addition to the owner. This keeps
    // the gate consistent with the mobile + dashboard banners which
    // also exclude business_owner from their count.
    const r = await query(
      `SELECT COUNT(*)::int AS c FROM business_users
        WHERE business_id = $1 AND is_active = TRUE
          AND role <> 'business_owner'`,
      [businessId],
    );
    return r.rows[0].c;
  }
  if (metric === 'tables') {
    // Push 16d — gate table creation by plan.
    const r = await query(
      'SELECT COUNT(*)::int AS c FROM tables WHERE business_id = $1',
      [businessId],
    );
    return r.rows[0].c;
  }
  if (metric === 'floors') {
    const r = await query(
      'SELECT COUNT(*)::int AS c FROM floors WHERE business_id = $1',
      [businessId],
    );
    return r.rows[0].c;
  }
  if (metric === 'monthly_orders') {
    const period = new Date().toISOString().slice(0, 7);
    const r = await query(
      `SELECT count FROM usage_counters
        WHERE business_id = $1 AND metric = 'monthly_orders' AND period = $2`,
      [businessId, period],
    );
    return r.rowCount > 0 ? r.rows[0].count : 0;
  }
  return 0;
}

function serializePlan(p) {
  // FF-402c — one plan row, two prices. Yearly is optional (null =
  // this plan doesn't offer yearly). If not set explicitly we default
  // to 10× monthly (2 months free) so the dashboard has something
  // sensible to show without the admin filling both fields.
  const monthly = p.price_inr_paise || 0;
  const yearly = p.price_yearly_paise != null ? p.price_yearly_paise
    : monthly > 0 ? monthly * 10 : null;
  return {
    id: p.id,
    tier: p.tier,
    tierKind: p.tier_kind, // Push 14d — surface tier_kind so admin
    // can edit feature matrix per tier_kind
    name: p.name,
    priceInr: monthly / 100,
    priceInrPaise: monthly,
    priceYearlyInr: yearly != null ? yearly / 100 : null,
    priceYearlyInrPaise: yearly,
    // Legacy — kept for anything still reading plan.billingPeriod.
    // A plan itself no longer has a single billing period; each
    // subscription picks monthly vs yearly at checkout.
    billingPeriod: p.billing_period,
    razorpayPlanId: p.razorpay_plan_id,
    razorpayPlanIdYearly: p.razorpay_plan_id_yearly,
    isActive: p.is_active,
    // 2026-09-03 custom plans (migration 074): is_public=FALSE hides a plan
    // from public catalogs; business_id scopes it to exactly one tenant.
    isPublic: p.is_public !== false,
    businessId: p.business_id || null,
    limits: p.limits || {},
    features: p.features || {},
  };
}

function serializeSubscription(s, plan) {
  return {
    id: s.id,
    businessId: s.business_id,
    plan: plan ? serializePlan(plan) : null,
    status: s.status,
    trialEndsAt: s.trial_ends_at,
    currentPeriodStart: s.current_period_start,
    currentPeriodEnd: s.current_period_end,
    cancelAtPeriodEnd: s.cancel_at_period_end,
    cancelledAt: s.cancelled_at,
    // FF-402c — cadence lives on the sub row now (not on the plan).
    billingPeriod: s.billing_period || 'monthly',
  };
}

// ── Plans ────────────────────────────────────────────────────────────────

// 2026-09-03 custom plans: public surfaces (GET /v1/plans anonymous,
// /v1/public/plans, landing feed) list only is_public plans. When a tenant
// context is known (`forBusinessId`), THAT tenant's own custom plan is
// included too so their BillingPage shows the plan they're actually on.
async function listPlans({ forBusinessId = null } = {}) {
  const r = forBusinessId
    ? await query(
      `SELECT * FROM plans
          WHERE is_active = TRUE AND (is_public = TRUE OR business_id = $1)
          ORDER BY price_inr_paise ASC`,
      [forBusinessId],
    )
    : await query(
      `SELECT * FROM plans
          WHERE is_active = TRUE AND is_public = TRUE
          ORDER BY price_inr_paise ASC`,
    );
  return r.rows.map(serializePlan);
}

async function getPlanByTier(tier) {
  const r = await query('SELECT * FROM plans WHERE tier = $1 LIMIT 1', [tier]);
  if (r.rowCount === 0) throw new NotFound(`Plan ${tier} not found`);
  return r.rows[0];
}

async function updatePlan(tier, patch) {
  // FF-402c — plan carries BOTH price columns now; billing_period on
  // the plan row is deprecated but we still let admins tweak it for
  // legacy tooling.
  const fields = ['name', 'price_inr_paise', 'price_yearly_paise',
    'is_active', 'limits', 'features',
    'razorpay_plan_id', 'razorpay_plan_id_yearly',
    'billing_period', 'tier_kind'];
  const sets = [];
  const values = [];
  let idx = 1;
  for (const f of fields) {
    if (patch[f] !== undefined) {
      sets.push(`${f} = $${idx}`);
      values.push(['limits', 'features'].includes(f) ? JSON.stringify(patch[f]) : patch[f]);
      idx += 1;
    }
  }
  // FF-402e — starter is trial-only. If this update targets a starter
  // plan or leaves price at 0, force yearly columns to null so we
  // never accidentally publish a yearly starter row.
  const currentPlan = await getPlanByTier(tier);
  const nextTierKind = patch.tier_kind || currentPlan?.tier_kind;
  const nextMonthly = patch.price_inr_paise != null
    ? patch.price_inr_paise
    : (currentPlan?.price_inr_paise || 0);
  if (nextTierKind === planTiers.STARTER_TIER_KIND || nextMonthly === 0) {
    // Overwrite the "$N = value" slot for price_yearly_paise if the
    // caller set it, or append a null-setter if they didn't. Cheapest
    // approach: unconditionally push a null assignment (idempotent).
    const yearlyIdx = fields.indexOf('price_yearly_paise');
    const alreadySetting = sets.some((s) => s.startsWith('price_yearly_paise'));
    if (yearlyIdx >= 0 && !alreadySetting) {
      sets.push(`price_yearly_paise = $${idx}`);
      values.push(null);
      idx += 1;
    } else if (alreadySetting) {
      // Force whatever the caller sent to null.
      const paramIdx = sets.findIndex((s) => s.startsWith('price_yearly_paise'));
      values[paramIdx] = null;
    }
  }
  if (sets.length === 0) return getPlanByTier(tier);
  values.push(tier);
  const r = await query(
    `UPDATE plans SET ${sets.join(', ')} WHERE tier = $${idx} RETURNING *`,
    values,
  );
  if (r.rowCount === 0) throw new NotFound('Plan not found');
  // Push 14d — invalidate ALL feature caches when a plan is mutated so
  // every business immediately sees the new tier matrix on the next call.
  try { require('./featureService').clearAllCaches(); } catch (_) {}
  return r.rows[0];
}

// Push 14d — admin plan CRUD (super-admin only). `plans.tier` is a free-form
// VARCHAR(40) tier CODE since migration 039 (the plan_tier enum is gone);
// `tier_kind` must be one of planTiers.TIER_KIND_LADDER, which is what the
// route's Joi schema enforces. Limits + features are JSONB.
async function createPlan(body) {
  const {
    tier, tier_kind, name,
    price_inr_paise = 0,
    // FF-402c — yearly optional. If caller didn't set it we default
    // to 10× monthly (2 months free) so the dashboard has a yearly
    // price to show. Passing null explicitly disables the yearly
    // option for that plan.
    price_yearly_paise,
    billing_period = 'monthly',
    is_active = true, limits = {}, features = {},
    razorpay_plan_id = null,
    razorpay_plan_id_yearly = null,
  } = body;
  // FF-402e — Starter is trial-only by definition (no committed billing),
  // so we hard-block yearly on the starter tier kind regardless of what
  // the admin sent. Same for price = 0 (free tiers can't have a yearly
  // charge). Pro / Enterprise auto-default to 10× monthly (2 months free).
  const yearlyPaise = (tier_kind === planTiers.STARTER_TIER_KIND || price_inr_paise === 0)
    ? null
    : (price_yearly_paise !== undefined
      ? price_yearly_paise
      : price_inr_paise * 10);
  if (!tier || !name) throw new Error('tier and name are required');
  // Push 18a — surface a friendly conflict message instead of letting the
  // raw PG 23505 propagate. The dashboard already maps 23505 to "CONFLICT"
  // but a tier-specific hint is more useful than "Duplicate value".
  const existing = await query('SELECT tier FROM plans WHERE tier = $1', [tier]);
  if (existing.rowCount > 0) {
    const err = new Error(`A plan with tier "${tier}" already exists. Pick a different tier code.`);
    err.statusCode = 409;
    err.code = 'TIER_ALREADY_EXISTS';
    throw err;
  }
  const r = await query(
    `INSERT INTO plans
       (tier, tier_kind, name, price_inr_paise, price_yearly_paise,
        billing_period, is_active, limits, features,
        razorpay_plan_id, razorpay_plan_id_yearly)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [tier, tier_kind || planTiers.FALLBACK_TIER_KIND, name, price_inr_paise, yearlyPaise,
      billing_period, is_active,
      JSON.stringify(limits), JSON.stringify(features),
      razorpay_plan_id, razorpay_plan_id_yearly],
  );
  try { require('./featureService').clearAllCaches(); } catch (_) {}
  return r.rows[0];
}

async function deletePlan(tier) {
  // Don't allow deleting a plan that still has active subscriptions —
  // that would orphan customers. Caller should migrate them first.
  const used = await query(
    `SELECT COUNT(*)::int AS c FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
      WHERE p.tier = $1 AND s.status IN ('active','trialing')`,
    [tier],
  );
  if (used.rows[0].c > 0) {
    const err = new Error(
      `Cannot delete plan ${tier}: ${used.rows[0].c} active subscription(s) still on it. `
      + 'Move customers to another plan first.',
    );
    err.statusCode = 409;
    throw err;
  }
  const r = await query('DELETE FROM plans WHERE tier = $1 RETURNING *', [tier]);
  if (r.rowCount === 0) throw new NotFound('Plan not found');
  try { require('./featureService').clearAllCaches(); } catch (_) {}
  return r.rows[0];
}

async function listAllPlans() {
  const r = await query('SELECT * FROM plans ORDER BY price_inr_paise ASC');
  return r.rows.map(serializePlan);
}

// ── Subscriptions ────────────────────────────────────────────────────────

async function get(businessId) {
  const r = await query(
    `SELECT s.*, p.* FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
      WHERE s.business_id = $1 LIMIT 1`,
    [businessId],
  );
  if (r.rowCount === 0) return null;
  // Split joined row
  const row = r.rows[0];
  const plan = await getPlanByTier(row.tier);
  return serializeSubscription(row, plan);
}

// X2 (2026-08-28) — proration on a mid-cycle UPGRADE. Returns the pro-rated
// delta (in paise) the tenant owes now for the unused remainder of the
// current period. Only for a genuine upgrade (new price > old, same cadence)
// on an ACTIVE (non-trial) sub. Trials, downgrades, and same/lower price →
// 0. This is the amount to capture via Razorpay when live; today it is
// computed, surfaced and logged so billing shows the right figure.
function computeProrationPaise(subRow, currentPlan, newPlan, cadence) {
  if (!subRow || !currentPlan || !newPlan) return 0;
  if (subRow.status !== 'active') return 0; // trials upgrade free until trial ends
  const yearly = cadence === 'yearly';
  const oldPrice = yearly ? (currentPlan.price_yearly_paise || 0) : (currentPlan.price_inr_paise || 0);
  const newPrice = yearly ? (newPlan.price_yearly_paise || 0) : (newPlan.price_inr_paise || 0);
  const delta = newPrice - oldPrice;
  if (delta <= 0) return 0; // downgrade / same price → no immediate charge
  const start = new Date(subRow.current_period_start).getTime();
  const end = new Date(subRow.current_period_end).getTime();
  const now = Date.now();
  const totalMs = end - start;
  const remainingMs = end - now;
  if (!(totalMs > 0) || remainingMs <= 0) return 0;
  return Math.round(delta * (remainingMs / totalMs));
}

async function changePlan(businessId, newTier, { billingPeriod = null } = {}) {
  const plan = await getPlanByTier(newTier);
  // 2026-09-03 (plans/addons audit #5): tenants can only self-serve onto a
  // plan that is (a) active, and (b) public OR their own custom plan. A
  // retired plan, a hidden internal plan, or another tenant's custom plan
  // all 400 PLAN_NOT_AVAILABLE. (Admin assignment uses
  // customerAdminService.setPlanManually, which is not restricted here.)
  const notAvailable = plan.is_active === false
    || (plan.business_id != null && String(plan.business_id) !== String(businessId))
    || (plan.is_public === false && plan.business_id == null);
  if (notAvailable) {
    const { HttpError } = require('../utils/errors');
    throw new HttpError(
      400,
      'This plan is not available',
      'PLAN_NOT_AVAILABLE',
      { tier: newTier },
    );
  }
  // Load the CURRENT sub + plan first so we can price the upgrade delta.
  const curQ = await query(
    `SELECT s.*, p.price_inr_paise, p.price_yearly_paise, p.tier AS cur_tier
       FROM subscriptions s LEFT JOIN plans p ON p.id = s.plan_id
      WHERE s.business_id = $1 LIMIT 1`,
    [businessId],
  );
  const curRow = curQ.rows[0] || null;
  const cadence = billingPeriod || curRow?.billing_period || 'monthly';
  const prorationPaise = curRow
    ? computeProrationPaise(curRow, curRow, plan, cadence)
    : 0;
  // billingPeriod (2026-08-24): when set (manual/beta path with no Razorpay),
  // persist the cadence and roll the period forward so the UI doesn't show a
  // stale "renews on <past date>". Left NULL → cadence unchanged (e.g. 'free').
  const period = billingPeriod === 'yearly' ? 'yearly'
    : billingPeriod === 'monthly' ? 'monthly' : null;
  const r = await query(
    `UPDATE subscriptions
        SET plan_id = $1,
            status = CASE WHEN status = 'trialing' THEN 'trialing'::subscription_status
                          ELSE 'active'::subscription_status END,
            billing_period = COALESCE($3, billing_period),
            current_period_start = CASE WHEN $3 IS NULL THEN current_period_start ELSE NOW() END,
            current_period_end = CASE
              WHEN $3 IS NULL THEN current_period_end
              WHEN $3 = 'yearly' THEN NOW() + INTERVAL '1 year'
              ELSE NOW() + INTERVAL '1 month' END,
            cancel_at_period_end = FALSE,
            updated_at = NOW()
      WHERE business_id = $2
      RETURNING *`,
    [plan.id, businessId, period],
  );
  if (r.rowCount === 0) throw new NotFound('No subscription on this business');
  // Invalidate the in-process feature cache so the new tier kicks in immediately.
  try { require('./featureService').clearCache(businessId); } catch (_) {}
  // Push 14e — on plan change auto-prune over-limit staff so the business
  // doesn't sit in an "over-limit but can't add new staff" deadlock.
  try {
    await require('./staffService').complyStaffLimit(businessId);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[changePlan] complyStaffLimit failed:', e?.message);
  }
  // X2 — log the pro-rated upgrade charge on the tenant timeline so it's
  // auditable and the dashboard can show "₹X due now for the upgrade".
  if (prorationPaise > 0) {
    try {
      await require('./crmService').logActivity({
        businessId,
        kind: 'proration',
        title: `Upgrade proration: ₹${(prorationPaise / 100).toFixed(2)}`,
        meta: { fromTier: curRow?.cur_tier, toTier: newTier, cadence, prorationPaise },
        actorType: 'system',
      });
    } catch (_) { /* non-fatal */ }
  }
  // 2026-09-03 — if this business is a group HQ, push the same entitlement to
  // every outlet so branches never lag behind the plan the owner paid for.
  try {
    await require('./multiOutletService').syncPlanToOutlets(businessId);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[changePlan] syncPlanToOutlets failed:', e?.message);
  }
  // 2026-09-03 — a downgrade must also drop addons the new plan can't hold
  // (e.g. multi-outlet is Pro+; dropping to a starter plan revokes it).
  try {
    const revoked = await require('./addonService').revokeIneligibleAddons(businessId);
    if (revoked.length > 0) {
      await require('./crmService').logActivity({
        businessId,
        kind: 'plan_change',
        title: `Add-ons revoked on plan change: ${revoked.join(', ')}`,
        meta: { revoked, newTier },
        actorType: 'system',
      }).catch(() => {});
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[changePlan] revokeIneligibleAddons failed:', e?.message);
  }
  const out = serializeSubscription(r.rows[0], plan);
  out.prorationInr = prorationPaise / 100;
  return out;
}

async function cancelAtPeriodEnd(businessId) {
  const r = await query(
    `UPDATE subscriptions
        SET cancel_at_period_end = TRUE,
            cancelled_at = NOW()
      WHERE business_id = $1
      RETURNING *`,
    [businessId],
  );
  if (r.rowCount === 0) throw new NotFound('No subscription');
  // P0 fix (2026-08-30): actually stop the Razorpay mandate. Previously this
  // only flipped local columns, so the gateway kept auto-charging the saved
  // UPI/card every cycle and the next `subscription.charged` webhook silently
  // re-activated the "cancelled" plan. cancel_at_cycle_end keeps service until
  // the paid period ends. Best-effort: never trap the owner if Razorpay errors
  // — the reactivation guard in _onChargeSuccess is the backstop.
  try {
    const rzp = require('./razorpayService');
    await rzp.cancelSubscription(businessId, { atCycleEnd: true });
  } catch (e) {
    require('../config/logger').warn(`Gateway cancel failed for business ${businessId}: ${e.message}`);
  }
  return r.rows[0];
}

async function resume(businessId) {
  const r = await query(
    `UPDATE subscriptions
        SET cancel_at_period_end = FALSE,
            cancelled_at = NULL,
            status = 'active'
      WHERE business_id = $1
      RETURNING *`,
    [businessId],
  );
  if (r.rowCount === 0) throw new NotFound('No subscription');
  return r.rows[0];
}

// ── Plan-limit enforcement ───────────────────────────────────────────────

/**
 * Express middleware factory.
 *   enforceLimit('menu_items')        → counts current menu_items
 *   enforceLimit('monthly_orders')    → counts orders in current month
 *   enforceLimit('staff')             → counts active business_users
 *
 * If the limit is -1 (unlimited) we let it through. If it's a positive
 * number and the count is >= limit, we 402 Payment Required with
 * { code: PLAN_LIMIT, limit, current }.
 */
function enforceLimit(metric) {
  return async (req, _res, next) => {
    if (req.user?.isSuperAdmin) return next();
    const businessId = req.params.businessId || req.user?.businessId;
    if (!businessId) return next();

    try {
      const eff = await effectivePlan(businessId);
      if (!eff.plan) return next();
      const limit = eff.plan.limits?.[metric];
      if (limit === undefined || limit === -1) return next(); // unlimited

      const current = await currentUsage(businessId, metric);

      if (current >= limit) {
        // X3 (2026-08-28) — drop a deduped upsell task for the sales team.
        // Fire-and-forget so it never delays or breaks the request.
        try {
          require('./crmService').ensureUpsellTask(businessId, metric, {
            limit, current, planTier: eff.plan.tier,
          }).catch(() => {});
        } catch (_) { /* non-fatal */ }
        // 2026-09-04 (pricing audit F-03) — the message is now something an
        // owner can act on rather than a column name and a fraction. The
        // WIRE SHAPE IS DELIBERATELY UNCHANGED: `error: 'PLAN_LIMIT'` plus
        // `details: { metric, limit, current, plan }`. Both the dashboard's
        // error path and its `plan_limit_hit` analytics hook read exactly
        // those keys (namastepos_dashboard/src/api/client.ts), so the extra
        // fields below are ADDITIVE only — never rename or drop the four.
        const err = new Forbidden(limitHitMessage(metric, limit));
        err.code = 'PLAN_LIMIT';
        err.details = {
          metric,
          limit,
          current,
          plan: eff.plan.tier,
          // Additive (safe for existing readers, useful for new ones).
          metricLabel: metricLabel(metric),
          remaining: 0,
          planName: eff.plan.name || null,
          upgradePath: '/billing',
        };
        return next(err);
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/**
 * Owner-facing copy for a BULK refusal. Says all four numbers an owner needs:
 * what the plan allows, what they already hold, what the file would add, and
 * which plan lifts the limit. `requiredLabel` comes from the tier ladder
 * (planTiers.nextKindUp -> labelOf) — never a guessed plan name.
 */
function bulkLimitMessage(metric, {
  limit, current, wanted, requiredLabel,
}) {
  const label = metricLabel(metric);
  const room = Math.max(0, limit - current);
  const over = current + wanted - limit;
  const upgrade = requiredLabel
    ? `Upgrade to ${requiredLabel} to bring them all in`
    : 'Upgrade to bring them all in';
  const trim = room > 0
    ? `, or import ${room} ${room === 1 ? 'row' : 'rows'} at a time.`
    : ', or deactivate items you no longer sell to free up room.';
  return `Your plan covers ${limit} ${label}. You already have ${current} and this `
    + `import adds ${wanted} — ${current + wanted} in total, ${over} over the limit. `
    + `Nothing was imported. ${upgrade}${trim}`;
}

/**
 * Pre-write capacity gate for BULK writes (2026-09-04).
 *
 * `enforceLimit` is a per-request middleware: it answers "is there room for
 * ONE more?". A bulk import needs "is there room for N more?" BEFORE the first
 * row is written — otherwise the owner imports 45 dishes on a 10-dish plan and
 * meets the wall on row 46, i.e. after all the work, which is the worst
 * possible moment (POST /menu/bulk did exactly that).
 *
 * Returns `{ limit, current, remaining }` when there is room, or `null` when
 * the metric is uncapped / unlimited (-1) / the tenant has no plan. Throws the
 * SAME 403 PLAN_LIMIT contract enforceLimit uses — `error: 'PLAN_LIMIT'` plus
 * `details: { metric, limit, current, plan }` — because the dashboard banner
 * and the `plan_limit_hit` analytics hook (web api/client.ts, mobile
 * ApiService._maybeTrackPlanLimit) read exactly those keys. Everything else in
 * `details` is additive.
 */
async function assertCapacity(businessId, metric, wanted) {
  const want = Number(wanted);
  if (!businessId || !Number.isFinite(want) || want <= 0) return null;
  const eff = await effectivePlan(businessId);
  if (!eff.plan) return null;
  const raw = eff.plan.limits?.[metric];
  if (raw === undefined || raw === null || Number(raw) === -1) return null;
  const limit = Number(raw);
  if (!Number.isFinite(limit) || limit < 0) return null;

  const current = await currentUsage(businessId, metric);
  if (current + want <= limit) {
    return { limit, current, remaining: limit - current };
  }

  // Same deduped upsell task enforceLimit drops, so a refused import is as
  // visible to the sales team as a refused single create. Fire-and-forget.
  try {
    require('./crmService').ensureUpsellTask(businessId, metric, {
      limit, current, planTier: eff.plan.tier,
    }).catch(() => {});
  } catch (_) { /* non-fatal */ }

  const requiredKind = planTiers.nextKindUp(eff.plan.tierKind);
  const requiredLabel = planTiers.labelOf(requiredKind);
  const err = new Forbidden(bulkLimitMessage(metric, {
    limit, current, wanted: want, requiredLabel,
  }));
  err.code = 'PLAN_LIMIT';
  err.details = {
    // The four keys every existing reader parses. Never rename or drop them.
    metric,
    limit,
    current,
    plan: eff.plan.tier,
    // Additive.
    metricLabel: metricLabel(metric),
    remaining: Math.max(0, limit - current),
    attempted: want,
    planName: eff.plan.name || null,
    requiredTierKind: requiredKind || null,
    requiredTierLabel: requiredLabel || null,
    upgradePath: '/billing',
  };
  throw err;
}

/**
 * The plan whose LIMITS actually apply right now.
 *
 * 2026-09-04. This used to be implicit: enforceLimit read `get(businessId)`,
 * which joins whatever plan_id the row happens to carry, no matter what state
 * the subscription is in. That was survivable while every trial was a Starter
 * trial. It is not survivable now that a trial runs on a real paid plan — a
 * lapsed Pro trial would keep unlimited orders and unlimited menu items until
 * the nightly downgrade swept it up, i.e. for up to a day, for free.
 *
 * So limits resolve through the SAME entitlement predicate as features
 * (planEntitlement): entitled → the subscription's plan (which is what makes
 * the past_due grace window cover caps as well as features); not entitled →
 * the free/starter plan. One rule, both gates.
 */
async function effectivePlan(businessId) {
  const r = await query(
    `SELECT s.status, s.trial_ends_at, s.past_due_at, s.last_dunning_at,
            s.plan_id
       FROM subscriptions s
      WHERE s.business_id = $1
      LIMIT 1`,
    [businessId],
  );
  if (r.rowCount === 0) return { plan: null, entitled: false, reason: 'none' };
  const row = r.rows[0];
  const c = entitlement.classify(row);
  const planId = c.entitled ? row.plan_id : null;
  let plan = null;
  if (planId) {
    const p = await query('SELECT * FROM plans WHERE id = $1 LIMIT 1', [planId]);
    plan = p.rows[0] ? serializePlan(p.rows[0]) : null;
  } else {
    // Lapsed: fall back to the free plan's caps, matching what
    // featureService resolves to (tier 'free' / tier_kind 'starter').
    const p = await query(
      `SELECT * FROM plans
        WHERE is_active = TRUE AND business_id IS NULL AND price_inr_paise = 0
        ORDER BY created_at ASC LIMIT 1`,
    );
    plan = p.rows[0] ? serializePlan(p.rows[0]) : null;
  }
  return { plan, entitled: c.entitled, reason: c.reason, status: row.status };
}

/**
 * Owner-facing usage meter for every capped metric on the effective plan.
 *
 * 2026-09-04 (pricing audit F-03 / retention audit F-03). The 80%-of-cap
 * "near limit" flag existed only in the super-admin console
 * (platformOpsService → admin UsagePage), where the person who can actually
 * act on it — the restaurant owner — cannot see it. The counts already lived
 * in `usage_counters`; this exposes them on a route the tenant dashboard and
 * the mobile app ALREADY call on every launch
 * (GET /v1/businesses/:bid/billing), so no new endpoint and no new polling.
 *
 * `level`:
 *   ok       — under the warn threshold
 *   warn     — at or past 80% of the cap
 *   critical — at or past 100%; the next attempt is the 403
 */
const WARN_AT = 0.8;

async function usageSummary(businessId) {
  const eff = await effectivePlan(businessId);
  const limits = eff.plan?.limits || {};
  const out = [];
  for (const metric of COUNTABLE_METRICS) {
    const limit = limits[metric];
    // Absent or -1 = unlimited: nothing to warn about, so it is not reported.
    if (limit === undefined || limit === null || limit === -1) continue;
    const numeric = Number(limit);
    if (!Number.isFinite(numeric) || numeric < 0) continue;
    let current = 0;
    try {
      current = await currentUsage(businessId, metric);
    } catch (_) { continue; } // a missing table must not break the billing read
    const remaining = Math.max(0, numeric - current);
    const pct = numeric > 0 ? Math.min(999, Math.round((current / numeric) * 100)) : 100;
    const level = current >= numeric ? 'critical' : (pct >= WARN_AT * 100 ? 'warn' : 'ok');
    out.push({
      metric,
      label: metricLabel(metric),
      limit: numeric,
      current,
      remaining,
      pct,
      level,
      message: level === 'critical'
        ? limitHitMessage(metric, numeric)
        : limitWarnMessage(metric, remaining, numeric),
    });
  }
  return {
    planTier: eff.plan?.tier || null,
    planName: eff.plan?.name || null,
    // True when the effective plan is NOT the subscribed plan (lapsed trial /
    // past grace), so the dashboard can explain why the caps changed.
    entitled: eff.entitled,
    reason: eff.reason,
    warnAtPct: WARN_AT * 100,
    metrics: out,
  };
}

/**
 * Bump a monthly counter (call after a successful order).
 *
 * P0-5 hardening: the previous code was a check-then-write split across
 * `enforceLimit` (read count) and this function (increment). Under load two
 * requests could both read `count = limit - 1`, both pass enforceLimit, and
 * both insert — exceeding the paid quota.
 *
 * We keep the per-request `enforceLimit` gate (cheap, returns the right 402
 * error code to the client) but also enforce the limit atomically here so
 * that even a race-winner cannot push the counter past the cap. If the
 * UPDATE clause sees `count >= limit` it returns 0 rows and we throw 402.
 */
async function incrementUsage(businessId, metric = 'monthly_orders', { limit = null } = {}) {
  const period = new Date().toISOString().slice(0, 7);
  if (limit === null || limit === -1) {
    // Unlimited: simple upsert, no race risk on the cap.
    await query(
      `INSERT INTO usage_counters (business_id, metric, period, count, updated_at)
       VALUES ($1, $2, $3, 1, NOW())
       ON CONFLICT (business_id, metric, period)
       DO UPDATE SET count = usage_counters.count + 1, updated_at = NOW()`,
      [businessId, metric, period],
    );
    return;
  }
  // Atomic compare-and-set: only increment if we're still under the cap.
  const r = await query(
    `INSERT INTO usage_counters (business_id, metric, period, count, updated_at)
     VALUES ($1, $2, $3, 1, NOW())
     ON CONFLICT (business_id, metric, period)
     DO UPDATE SET count = usage_counters.count + 1, updated_at = NOW()
       WHERE usage_counters.count < $4
     RETURNING count`,
    [businessId, metric, period, limit],
  );
  if (r.rowCount === 0) {
    // Keep the "Plan limit reached for <metric>: n/n" prefix: the dashboard's
    // error interceptor regex-parses this message as its fallback when a
    // PLAN_LIMIT arrives with no details (this 402 race-backstop was the only
    // such path). Details are now attached too, so the regex is belt-and-
    // braces rather than the only source.
    const err = new Forbidden(
      `Plan limit reached for ${metric}: ${limit}/${limit}. ${limitHitMessage(metric, limit)}`,
    );
    err.code = 'PLAN_LIMIT';
    err.statusCode = 402;
    err.details = {
      metric,
      limit,
      current: limit,
      plan: null,
      metricLabel: metricLabel(metric),
      remaining: 0,
      upgradePath: '/billing',
    };
    throw err;
  }
}

module.exports = {
  listPlans,
  listAllPlans,
  getPlanByTier,
  updatePlan,
  createPlan,
  deletePlan,
  serializePlan,
  get,
  changePlan,
  cancelAtPeriodEnd,
  resume,
  serializeSubscription,
  enforceLimit,
  // Pre-write gate for bulk writes (N rows at once), same 403 contract.
  assertCapacity,
  incrementUsage,
  // 2026-09-04 — owner-facing limit warnings + shared entitlement resolution.
  effectivePlan,
  usageSummary,
  currentUsage,
  metricLabel,
  COUNTABLE_METRICS,
};
