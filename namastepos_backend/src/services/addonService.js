// NamastePOS backend - add-on marketplace service
//
// Each add-on is a separately-billable feature module. A business pays:
//    plan_price + sum(active_addon_prices)
//
// We create one Razorpay subscription per addon-activation so cancellation
// of one does not affect another. Customers can subscribe/cancel individually.

const https = require('https');
const env = require('../config/env');
const { query, withTransaction } = require('../config/db');
const { NotFound, BadRequest, Conflict, Forbidden } = require('../utils/errors');

// ── Razorpay helper (mirrors razorpayService for addon-scoped calls) ───
function rzCall(method, path, body) {
  return new Promise((resolve, reject) => {
    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
      return reject(new BadRequest('Razorpay is not configured'));
    }
    const data = body ? JSON.stringify(body) : null;
    const auth = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64');
    const req = https.request({
      hostname: 'api.razorpay.com', path, method,
      headers: {
        'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => {
        try {
          const json = chunks ? JSON.parse(chunks) : {};
          if (res.statusCode >= 300) return reject(new Error(json.error?.description || 'Razorpay error'));
          resolve(json);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Serializers ─────────────────────────────────────────────────────────
function serializeAddon(a) {
  return {
    id: a.id, slug: a.slug, name: a.name,
    tagline: a.tagline, description: a.description,
    icon: a.icon, category: a.category,
    priceInr: a.price_inr_paise / 100,
    priceInrPaise: a.price_inr_paise,
    billingPeriod: a.billing_period,
    requiredPlanTier: a.required_plan_tier,
    trialDays: a.trial_days,
    features: a.features || {},
    razorpayPlanId: a.razorpay_plan_id,
    isActive: a.is_active,
    displayOrder: a.display_order,
    createdAt: a.created_at,
  };
}

function serializeActivation(a, addon = null) {
  return {
    id: a.id,
    businessId: a.business_id,
    addon: addon ? serializeAddon(addon) : { id: a.addon_id, slug: a.slug, name: a.name },
    status: a.status,
    activatedAt: a.activated_at,
    trialEndsAt: a.trial_ends_at,
    currentPeriodStart: a.current_period_start,
    currentPeriodEnd: a.current_period_end,
    cancelAtPeriodEnd: a.cancel_at_period_end,
    cancelledAt: a.cancelled_at,
    settings: a.settings || {},
  };
}

// ── Catalog (public + super admin) ──────────────────────────────────────
async function listCatalog({ onlyActive = true } = {}) {
  const where = onlyActive ? 'WHERE is_active = TRUE' : '';
  const r = await query(`SELECT * FROM addons ${where} ORDER BY display_order ASC`);
  return r.rows.map(serializeAddon);
}

async function getBySlug(slug) {
  const r = await query(`SELECT * FROM addons WHERE slug = $1 LIMIT 1`, [slug]);
  if (r.rowCount === 0) throw new NotFound(`Addon ${slug} not found`);
  return r.rows[0];
}

async function getById(id) {
  const r = await query(`SELECT * FROM addons WHERE id = $1 LIMIT 1`, [id]);
  if (r.rowCount === 0) throw new NotFound('Addon not found');
  return r.rows[0];
}

// ── Admin CRUD ──────────────────────────────────────────────────────────
async function createAddon(body) {
  const required = ['slug', 'name', 'price_inr_paise'];
  for (const f of required) if (body[f] === undefined) throw new BadRequest(`Missing field: ${f}`);
  try {
    const r = await query(
      `INSERT INTO addons
         (slug, name, tagline, description, icon, category,
          price_inr_paise, billing_period, required_plan_tier,
          trial_days, features, is_active, display_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [body.slug, body.name, body.tagline || null, body.description || null,
       body.icon || 'box', body.category || 'operations',
       body.price_inr_paise, body.billing_period || 'monthly',
       body.required_plan_tier || null, body.trial_days || 0,
       JSON.stringify(body.features || {}),
       body.is_active !== false,
       body.display_order || 100]
    );
    return serializeAddon(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') throw new Conflict('Slug already exists');
    throw err;
  }
}

async function updateAddon(slug, patch) {
  const fields = ['name', 'tagline', 'description', 'icon', 'category',
                  'price_inr_paise', 'billing_period', 'required_plan_tier',
                  'trial_days', 'features', 'is_active', 'display_order',
                  'razorpay_plan_id'];
  const sets = []; const values = []; let idx = 1;
  for (const f of fields) {
    if (patch[f] !== undefined) {
      sets.push(`${f} = $${idx++}`);
      values.push(f === 'features' ? JSON.stringify(patch[f]) : patch[f]);
    }
  }
  if (sets.length === 0) return serializeAddon(await getBySlug(slug));
  values.push(slug);
  const r = await query(
    `UPDATE addons SET ${sets.join(', ')} WHERE slug = $${idx} RETURNING *`,
    values
  );
  if (r.rowCount === 0) throw new NotFound('Addon not found');
  return serializeAddon(r.rows[0]);
}

/** Sync each addon to Razorpay as its own Plan (one-time setup). */
async function syncRazorpayPlans() {
  const r = await query(`SELECT * FROM addons WHERE is_active = TRUE AND price_inr_paise > 0`);
  const synced = [];
  for (const a of r.rows) {
    if (a.razorpay_plan_id) { synced.push({ slug: a.slug, ok: true, existing: true }); continue; }
    try {
      const created = await rzCall('POST', '/v1/plans', {
        period: a.billing_period === 'yearly' ? 'yearly' : 'monthly',
        interval: 1,
        item: {
          name: `NamastePOS · ${a.name}`,
          amount: a.price_inr_paise,
          currency: 'INR',
          description: a.tagline || a.name,
        },
      });
      await query(`UPDATE addons SET razorpay_plan_id = $1 WHERE id = $2`, [created.id, a.id]);
      synced.push({ slug: a.slug, ok: true, razorpayPlanId: created.id });
    } catch (err) {
      synced.push({ slug: a.slug, ok: false, error: err.message });
    }
  }
  return synced;
}

// ── Activations (per business) ──────────────────────────────────────────
async function listActiveForBusiness(businessId) {
  const r = await query(
    `SELECT ba.*, a.slug, a.name, a.icon, a.category, a.price_inr_paise,
            a.features, a.tagline
       FROM business_addons ba
       JOIN addons a ON a.id = ba.addon_id
      WHERE ba.business_id = $1
        AND ba.status IN ('trialing','active','past_due')
      ORDER BY a.display_order ASC`,
    [businessId]
  );
  return r.rows.map((row) => ({
    ...serializeActivation(row),
    addon: {
      id: row.addon_id, slug: row.slug, name: row.name,
      icon: row.icon, category: row.category, tagline: row.tagline,
      priceInr: row.price_inr_paise / 100,
      features: row.features || {},
    },
  }));
}

async function listAllForBusiness(businessId) {
  const r = await query(
    `SELECT ba.*, a.slug, a.name FROM business_addons ba
       JOIN addons a ON a.id = ba.addon_id
      WHERE ba.business_id = $1
      ORDER BY ba.created_at DESC`,
    [businessId]
  );
  return r.rows.map((row) => ({ ...serializeActivation(row) }));
}

/** Is this business currently entitled to this addon? */
async function hasAddon(businessId, slug) {
  const r = await query(
    `SELECT 1 FROM business_addons ba JOIN addons a ON a.id = ba.addon_id
      WHERE ba.business_id = $1
        AND a.slug = $2
        AND ba.status IN ('trialing','active','past_due')
        AND ba.current_period_end > NOW()`,
    [businessId, slug]
  );
  return r.rowCount > 0;
}

/**
 * Start a paid subscription for an addon. Returns Razorpay checkout payload
 * so the dashboard can open Checkout.js.
 */
async function subscribe(businessId, slug) {
  const addon = await getBySlug(slug);

  // Plan compatibility check — Push 18a made plan tiers arbitrary VARCHAR,
  // so we can't compare by hardcoded order. Compare by `tier_kind` ordering
  // (starter < pro < enterprise) which is the canonical scale, falling back
  // to "any non-free" for legacy plans that lack tier_kind.
  if (addon.required_plan_tier) {
    const planCheck = await query(
      `SELECT p.tier, p.tier_kind, p.price_inr_paise
         FROM subscriptions s JOIN plans p ON p.id = s.plan_id
        WHERE s.business_id = $1`, [businessId]
    );
    const required = await query(
      `SELECT tier_kind, price_inr_paise FROM plans WHERE tier = $1 LIMIT 1`,
      [addon.required_plan_tier]
    );
    const kindOrder = { starter: 0, pro: 1, enterprise: 2 };
    const curKind = planCheck.rows[0]?.tier_kind || 'starter';
    const curPaise = planCheck.rows[0]?.price_inr_paise ?? 0;
    const reqKind = required.rows[0]?.tier_kind || 'starter';
    const reqPaise = required.rows[0]?.price_inr_paise ?? 0;
    const ok = kindOrder[curKind] >= kindOrder[reqKind] && curPaise >= reqPaise;
    if (!ok) {
      throw new Forbidden(`This addon requires ${addon.required_plan_tier} plan or higher`);
    }
  }

  // Already active?
  const existing = await query(
    `SELECT * FROM business_addons
      WHERE business_id = $1 AND addon_id = $2`,
    [businessId, addon.id]
  );
  if (existing.rowCount > 0
      && ['trialing', 'active', 'past_due'].includes(existing.rows[0].status)) {
    throw new Conflict('Addon already active for this business');
  }

  // Push 16g — every addon activates for free now. Marketplace is no
  // longer a paid storefront; features come from the plan, and addons
  // are just toggles for things that don't fit cleanly in plan_features.
  // The Razorpay branch below stays in code so a future paid addon can
  // be re-enabled by flipping a config — but the current default is
  // free instant activation.
  if (true || addon.price_inr_paise === 0) {
    const ins = await query(
      `INSERT INTO business_addons
         (business_id, addon_id, status, trial_ends_at, current_period_end)
       VALUES ($1, $2, 'active',
               NULL, NOW() + INTERVAL '100 years')
       ON CONFLICT (business_id, addon_id) DO UPDATE
         SET status = 'active', cancelled_at = NULL, cancel_at_period_end = FALSE
       RETURNING *`,
      [businessId, addon.id]
    );
    try { require('./featureService').clearCache(businessId); } catch (_) { /* non-fatal */ }
    return { activated: true, activation: serializeActivation(ins.rows[0], addon) };
  }

  // Paid addon (DISABLED in Push 16g — kept for future use) → Razorpay
  if (!addon.razorpay_plan_id) {
    throw new BadRequest('Addon Razorpay plan not synced. Run /admin/addons/sync-razorpay first.');
  }
  const sub = await rzCall('POST', '/v1/subscriptions', {
    plan_id: addon.razorpay_plan_id,
    customer_notify: 1,
    total_count: 120,
    notes: { businessId, addonSlug: addon.slug, kind: 'addon' },
  });

  // Stash pending row
  const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const trialEnds = addon.trial_days > 0
    ? new Date(Date.now() + addon.trial_days * 24 * 60 * 60 * 1000)
    : null;
  await query(
    `INSERT INTO business_addons
       (business_id, addon_id, status, trial_ends_at,
        current_period_end, razorpay_subscription_id)
     VALUES ($1, $2,
             CASE WHEN $3::int > 0 THEN 'trialing'::addon_status ELSE 'trialing'::addon_status END,
             $4, $5, $6)
     ON CONFLICT (business_id, addon_id) DO UPDATE
       SET status = 'trialing'::addon_status,
           cancelled_at = NULL,
           cancel_at_period_end = FALSE,
           razorpay_subscription_id = EXCLUDED.razorpay_subscription_id,
           current_period_end = EXCLUDED.current_period_end,
           trial_ends_at = EXCLUDED.trial_ends_at`,
    [businessId, addon.id, addon.trial_days, trialEnds, periodEnd, sub.id]
  );

  return {
    activated: false,
    checkoutOptions: {
      key: env.RAZORPAY_KEY_ID,
      subscription_id: sub.id,
      name: 'NamastePOS',
      description: `${addon.name} addon · ${addon.tagline}`,
      theme: { color: '#FF6B35' },
    },
  };
}

async function cancel(businessId, slug) {
  const addon = await getBySlug(slug);
  // Fix (2026-08-24): cancel used to only set cancel_at_period_end=TRUE while
  // leaving status='active' and current_period_end 100 years out (set by the
  // free instant-activation path). Since addons activate for free with no real
  // billing period, "cancel at period end" meant the addon — and its feature —
  // never actually turned off, so the owner saw it "cancelled but still active".
  // Cancel now takes effect immediately: status='cancelled', period ended now.
  const r = await query(
    `UPDATE business_addons
        SET status = 'cancelled'::addon_status,
            cancel_at_period_end = TRUE,
            cancelled_at = NOW(),
            current_period_end = NOW()
      WHERE business_id = $1 AND addon_id = $2
      RETURNING *`,
    [businessId, addon.id]
  );
  if (r.rowCount === 0) throw new NotFound('Addon not subscribed');
  // Bust the 60s feature cache so the gated feature locks right away instead
  // of lingering until the cache expires.
  try { require('./featureService').clearCache(businessId); } catch (_) { /* non-fatal */ }
  return serializeActivation(r.rows[0], addon);
}

/**
 * Push 20a — hard-cancel an addon. Used by the super-admin "Detach"
 * button which expects the addon to actually disappear from the
 * customer's account, not just be scheduled for end-of-period removal.
 *
 * Difference vs cancel():
 *   cancel() → cancel_at_period_end=true, status stays 'active'
 *   detach() → status='cancelled', current_period_end=NOW()
 */
async function detach(businessId, slug) {
  const addon = await getBySlug(slug);
  const r = await query(
    `UPDATE business_addons
        SET status = 'cancelled'::addon_status,
            cancel_at_period_end = TRUE,
            cancelled_at = NOW(),
            current_period_end = NOW()
      WHERE business_id = $1 AND addon_id = $2
      RETURNING *`,
    [businessId, addon.id]
  );
  if (r.rowCount === 0) throw new NotFound('Addon not subscribed');
  return serializeActivation(r.rows[0], addon);
}

async function resume(businessId, slug) {
  const addon = await getBySlug(slug);
  const r = await query(
    `UPDATE business_addons
        SET cancel_at_period_end = FALSE, cancelled_at = NULL,
            status = 'active'::addon_status,
            -- 2026-08-24: cancel now ends the period immediately, so on resume
            -- push it back out (free instant-activation model = far future).
            current_period_end = NOW() + INTERVAL '100 years'
      WHERE business_id = $1 AND addon_id = $2
      RETURNING *`,
    [businessId, addon.id]
  );
  if (r.rowCount === 0) throw new NotFound('Addon not subscribed');
  try { require('./featureService').clearCache(businessId); } catch (_) { /* non-fatal */ }
  return serializeActivation(r.rows[0], addon);
}

async function updateSettings(businessId, slug, settings) {
  const addon = await getBySlug(slug);
  const r = await query(
    `UPDATE business_addons SET settings = $1
      WHERE business_id = $2 AND addon_id = $3 RETURNING *`,
    [JSON.stringify(settings), businessId, addon.id]
  );
  if (r.rowCount === 0) throw new NotFound('Addon not active');
  return serializeActivation(r.rows[0], addon);
}

// Webhook: Razorpay subscription event for an addon
async function handleRazorpayEvent(event, payload) {
  const sub = payload.subscription?.entity;
  if (!sub) return false;
  const notes = sub.notes || {};
  if (notes.kind !== 'addon') return false;

  const update = {};
  if (event === 'subscription.activated') update.status = 'active';
  if (event === 'subscription.charged') {
    update.status = 'active';
    update.current_period_end = new Date((sub.current_end || (Date.now() / 1000 + 30 * 86400)) * 1000);
  }
  if (event === 'subscription.cancelled' || event === 'subscription.completed') {
    update.status = 'cancelled';
    update.cancelled_at = new Date();
  }
  if (event === 'subscription.halted' || event === 'subscription.paused') {
    update.status = 'past_due';
  }

  if (Object.keys(update).length === 0) return true;
  const sets = []; const values = []; let idx = 1;
  for (const [k, v] of Object.entries(update)) {
    sets.push(`${k} = $${idx++}`);
    values.push(v);
  }
  values.push(sub.id);
  await query(
    `UPDATE business_addons SET ${sets.join(', ')}
      WHERE razorpay_subscription_id = $${idx}`,
    values
  );
  return true;
}

module.exports = {
  listCatalog, getBySlug, getById,
  createAddon, updateAddon, syncRazorpayPlans,
  listActiveForBusiness, listAllForBusiness, hasAddon,
  subscribe, cancel, detach, resume, updateSettings,
  handleRazorpayEvent,
  serializeAddon, serializeActivation,
};
