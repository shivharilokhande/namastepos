// NamastePOS backend — white-label branding (round-2 fix batch 2026-09-06, CONTRACTS §4)
//
// WHY THIS EXISTS
// `white_label` was sold on Enterprise and enforced nowhere (entitlements review
// 2026-09-05). This service owns the tenant's brand settings
// (businesses.white_label JSONB, migration 098) and — the part that makes the
// key REAL — `effective(businessId)`, which every diner-facing render site calls
// at request time: guest QR pages (guestController), the public mini-site
// (siteRender / publicSite) and the printed receipt (utils/tokenPrinter via
// orderController). `effective` re-checks featureService.hasFeature so a
// downgrade turns the branding off at once; the saved settings survive and come
// back on upgrade.
//
// SHAPE (wire, camelCase): { enabled, brandName, hidePoweredBy, accentColor }
//   enabled        master switch; nothing below applies while false
//   brandName      replaces "NamastePOS" in "Powered by …" when hidePoweredBy
//                  is false; null = keep NamastePOS (only the colour then)
//   hidePoweredBy  drop the attribution line entirely
//   accentColor    '#rrggbb' or null — validated here, the render sites still
//                  run their own safeColor() before it reaches a stylesheet
//
// `effective()` adds `poweredBy`: the attribution text a renderer should print
// ('NamastePOS' | '<brandName>' | null for none). Renderers print THAT and never
// decide the policy themselves.

const { query } = require('../config/db');
const { NotFound } = require('../utils/errors');

const DEFAULT_ATTRIBUTION = 'NamastePOS';
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const DEFAULTS = Object.freeze({
  enabled: false,
  brandName: null,
  hidePoweredBy: false,
  accentColor: null,
});

/** Coerce whatever the column (or a request body) holds into the canonical shape. */
function normalise(raw) {
  let obj = raw;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); } catch (_) { obj = {}; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) obj = {};
  const brandName = typeof obj.brandName === 'string' && obj.brandName.trim()
    ? obj.brandName.trim().slice(0, 80)
    : null;
  const accentColor = typeof obj.accentColor === 'string' && HEX_COLOR.test(obj.accentColor.trim())
    ? obj.accentColor.trim().toLowerCase()
    : null;
  return {
    enabled: obj.enabled === true,
    brandName,
    hidePoweredBy: obj.hidePoweredBy === true,
    accentColor,
  };
}

/** The saved settings (defaults when the row holds '{}'). 404 for an unknown business. */
async function get(businessId) {
  const r = await query(
    'SELECT white_label FROM businesses WHERE id = $1 AND deleted_at IS NULL LIMIT 1',
    [businessId],
  );
  if (r.rowCount === 0) throw new NotFound('Business not found');
  return normalise(r.rows[0].white_label);
}

/** Replace the settings (PUT semantics — the whole object every time). */
async function set(businessId, body) {
  const next = normalise(body);
  const r = await query(
    `UPDATE businesses SET white_label = $2::jsonb, updated_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING white_label`,
    [businessId, JSON.stringify(next)],
  );
  if (r.rowCount === 0) throw new NotFound('Business not found');
  return normalise(r.rows[0].white_label);
}

/**
 * What a renderer should apply RIGHT NOW for this business:
 *   { enabled, brandName, hidePoweredBy, accentColor, entitled, poweredBy }
 * `enabled` here is settings.enabled AND the plan still has `white_label`;
 * `poweredBy` is the attribution to print (null = print nothing).
 *
 * Never throws — a branding lookup must not break a diner's menu page. Any
 * failure returns the NamastePOS defaults.
 *
 * `rawSettings` lets a caller that already holds the businesses row (e.g.
 * tokenPrinter's caller) skip the settings query; the feature check still runs.
 */
async function effective(businessId, rawSettings = undefined) {
  const off = { ...DEFAULTS, entitled: false, poweredBy: DEFAULT_ATTRIBUTION };
  if (!businessId) return off;
  try {
    const settings = rawSettings === undefined ? await get(businessId) : normalise(rawSettings);
    // Re-checked at render time on purpose: the column being set is not the gate.
    const entitled = await require('./featureService').hasFeature(businessId, 'white_label');
    if (!entitled || !settings.enabled) {
      return { ...settings, enabled: false, entitled, poweredBy: DEFAULT_ATTRIBUTION };
    }
    return {
      ...settings,
      entitled: true,
      poweredBy: settings.hidePoweredBy ? null : (settings.brandName || DEFAULT_ATTRIBUTION),
    };
  } catch (_) {
    return off;
  }
}

module.exports = {
  DEFAULTS,
  DEFAULT_ATTRIBUTION,
  normalise,
  get,
  set,
  effective,
};
