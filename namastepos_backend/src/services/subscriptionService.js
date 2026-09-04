// NamastePOS backend - subscription + plan-limit service

const { query } = require('../config/db');
const { Forbidden, NotFound } = require('../utils/errors');

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
  if (nextTierKind === 'starter' || nextMonthly === 0) {
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

// Push 14d — admin plan CRUD (super-admin only). The plans.tier column is
// a plan_tier enum (free/basic/pro), so callers must POST one of those
// values; tier_kind is a free-form string. Limits + features are JSONB.
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
  const yearlyPaise = (tier_kind === 'starter' || price_inr_paise === 0)
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
    [tier, tier_kind || 'starter', name, price_inr_paise, yearlyPaise,
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
      const sub = await get(businessId);
      if (!sub) return next();
      const limit = sub.plan?.limits?.[metric];
      if (limit === undefined || limit === -1) return next(); // unlimited

      let current = 0;
      if (metric === 'menu_items') {
        const r = await query(
          `SELECT COUNT(*)::int AS c FROM menu_items
            WHERE business_id = $1 AND is_active = TRUE`,
          [businessId],
        );
        current = r.rows[0].c;
      } else if (metric === 'staff') {
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
        current = r.rows[0].c;
      } else if (metric === 'tables') {
        // Push 16d — gate table creation by plan. Starter typically gets
        // a small cap (e.g. 5), Pro 50, Enterprise -1 (unlimited).
        const r = await query(
          'SELECT COUNT(*)::int AS c FROM tables WHERE business_id = $1',
          [businessId],
        );
        current = r.rows[0].c;
      } else if (metric === 'floors') {
        const r = await query(
          'SELECT COUNT(*)::int AS c FROM floors WHERE business_id = $1',
          [businessId],
        );
        current = r.rows[0].c;
      } else if (metric === 'monthly_orders') {
        const period = new Date().toISOString().slice(0, 7);
        const r = await query(
          `SELECT count FROM usage_counters
            WHERE business_id = $1 AND metric = 'monthly_orders' AND period = $2`,
          [businessId, period],
        );
        current = r.rowCount > 0 ? r.rows[0].count : 0;
      }

      if (current >= limit) {
        // X3 (2026-08-28) — drop a deduped upsell task for the sales team.
        // Fire-and-forget so it never delays or breaks the request.
        try {
          require('./crmService').ensureUpsellTask(businessId, metric, {
            limit, current, planTier: sub.plan.tier,
          }).catch(() => {});
        } catch (_) { /* non-fatal */ }
        const err = new Forbidden(
          `Plan limit reached for ${metric}: ${current}/${limit}. Upgrade your plan.`,
        );
        err.code = 'PLAN_LIMIT';
        err.details = { metric, limit, current, plan: sub.plan.tier };
        return next(err);
      }
      return next();
    } catch (err) {
      return next(err);
    }
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
    const err = new Forbidden(`Plan limit reached for ${metric}: ${limit}/${limit}`);
    err.code = 'PLAN_LIMIT';
    err.statusCode = 402;
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
  incrementUsage,
};
