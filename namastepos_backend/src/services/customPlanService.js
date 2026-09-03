// NamastePOS — per-customer custom plans (2026-09-03).
//
// A custom plan is a normal `plans` row with:
//   tier        = 'custom-<first-8-of-businessId>'  (stable, unique per tenant)
//   is_public   = FALSE   (never appears on /v1/plans public, /v1/public/plans,
//                          the landing feed, or another tenant's plan list)
//   business_id = <the tenant>  (their own /v1/plans call includes it)
//
// Features ride the existing plan_features matrix keyed by the plan's tier
// code (Push 18b semantics), so featureService / featureGate need zero new
// logic. Razorpay plan ids are minted at create/update time via
// razorpayService.syncOnePlan (the bulk syncPlans skips non-public rows).
// Assignment reuses customerAdminService.setPlanManually so the staff-cap
// prune + cache invalidation behave exactly like the admin Set-Plan button.

const { query } = require('../config/db');
const { NotFound, Conflict } = require('../utils/errors');
const sub = require('./subscriptionService');
const features = require('./featureService');
const logger = require('../config/logger');

function customTierFor(businessId) {
  return `custom-${String(businessId).replace(/-/g, '').slice(0, 8)}`;
}

async function _planRowFor(businessId) {
  const r = await query(
    `SELECT * FROM plans WHERE business_id = $1 LIMIT 1`,
    [businessId]
  );
  return r.rowCount > 0 ? r.rows[0] : null;
}

async function _serializeWithFeatures(row) {
  const plan = sub.serializePlan(row);
  plan.featureKeys = await features.listTierFeatures(row.tier, row.tier_kind);
  return plan;
}

/** The tenant's custom plan (+featureKeys +assigned flag), or null. */
async function getForBusiness(businessId) {
  const row = await _planRowFor(businessId);
  if (!row) return null;
  const assignedQ = await query(
    `SELECT 1 FROM subscriptions WHERE business_id = $1 AND plan_id = $2 LIMIT 1`,
    [businessId, row.id]
  );
  const plan = await _serializeWithFeatures(row);
  plan.assigned = assignedQ.rowCount > 0;
  return plan;
}

/**
 * Create or update the tenant's custom plan.
 * body: { name, priceInrPaise, priceYearlyPaise|null, limits, featureKeys,
 *         tierKind, assign }
 */
async function upsertForBusiness(businessId, body) {
  const biz = await query(
    `SELECT id FROM businesses WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
    [businessId]
  );
  if (biz.rowCount === 0) throw new NotFound('Customer not found');

  const tier = customTierFor(businessId);
  const yearly = body.priceYearlyPaise === undefined ? null : body.priceYearlyPaise;
  const r = await query(
    `INSERT INTO plans
       (tier, tier_kind, name, price_inr_paise, price_yearly_paise,
        billing_period, is_active, limits, features, is_public, business_id)
     VALUES ($1, $2, $3, $4, $5, 'monthly', TRUE, $6, '{}'::jsonb, FALSE, $7)
     ON CONFLICT (tier) DO UPDATE
       SET tier_kind = EXCLUDED.tier_kind,
           name = EXCLUDED.name,
           price_inr_paise = EXCLUDED.price_inr_paise,
           price_yearly_paise = EXCLUDED.price_yearly_paise,
           is_active = TRUE,
           limits = EXCLUDED.limits,
           is_public = FALSE,
           business_id = EXCLUDED.business_id
     RETURNING *`,
    [tier, body.tierKind, body.name, body.priceInrPaise, yearly,
     JSON.stringify(body.limits || {}), businessId]
  );
  const row = r.rows[0];

  // Replace the plan's feature set (plan_features keyed by tier code).
  // setTierFeatures also clears all feature caches.
  await features.setTierFeatures(tier, body.featureKeys || []);

  // Mint/refresh Razorpay plan ids when priced (best-effort — a gateway
  // hiccup must not lose the admin's save; retry happens on next update).
  if (row.price_inr_paise > 0) {
    try {
      await require('./razorpayService').syncOnePlan(row.id);
    } catch (e) {
      logger.warn(`[custom-plan] Razorpay sync failed for ${tier}: ${e.message}`);
    }
  }

  let subscription = null;
  if (body.assign === true) {
    // Reuse the admin set-plan path: rolls the period forward, prunes
    // over-limit staff, clears the tenant's feature cache.
    subscription = await require('./customerAdminService')
      .setPlanManually(businessId, tier, { billingPeriod: 'monthly' });
  } else {
    try { features.clearCache(businessId); } catch (_) { /* non-fatal */ }
  }

  // Re-read so razorpay ids minted above are reflected.
  const fresh = await query(`SELECT * FROM plans WHERE id = $1`, [row.id]);
  const plan = await _serializeWithFeatures(fresh.rows[0]);
  plan.assigned = !!subscription
    || (await query(
      `SELECT 1 FROM subscriptions WHERE business_id = $1 AND plan_id = $2 LIMIT 1`,
      [businessId, row.id]
    )).rowCount > 0;
  return { plan, subscription };
}

/** Delete the tenant's custom plan. 409 while any subscription points at it. */
async function removeForBusiness(businessId) {
  const row = await _planRowFor(businessId);
  if (!row) throw new NotFound('No custom plan for this customer');
  const used = await query(
    `SELECT COUNT(*)::int AS c FROM subscriptions WHERE plan_id = $1`,
    [row.id]
  );
  if (used.rows[0].c > 0) {
    const err = new Conflict(
      'Custom plan is assigned to the customer\'s subscription. Move them to another plan first.'
    );
    err.code = 'CUSTOM_PLAN_ASSIGNED';
    throw err;
  }
  await query(`DELETE FROM plan_features WHERE tier_kind = $1`, [row.tier]);
  await query(`DELETE FROM plans WHERE id = $1`, [row.id]);
  try { features.clearAllCaches(); } catch (_) { /* non-fatal */ }
  return { deleted: true, tier: row.tier };
}

module.exports = { customTierFor, getForBusiness, upsertForBusiness, removeForBusiness };
