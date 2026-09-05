// NamastePOS — the business's declared GST scheme (2026-09-05, migration 092).
//
// ONE FACT, READ FROM ONE PLACE. Before this file the number 5 was hardcoded
// in three services and every starter template, and no code path anywhere
// asked the owner which scheme they were on. This module owns the mapping
// from a declared scheme to the GST slab their menu should default to, and
// nothing else in the codebase may hardcode that number again.
//
// THE THREE SCHEMES, and why only these three:
//
//   regular             5% and no input tax credit. The ordinary restaurant
//                       service rate and the default for every existing row,
//                       so behaviour is unchanged until an owner answers.
//   composition         The dealer pays GST out of their own pocket at a flat
//                       rate on turnover and charges the DINER nothing. They
//                       issue a BILL OF SUPPLY, not a tax invoice. Menu items
//                       therefore default to 0%, and orderService refuses to
//                       add GST to their bills even under ORDER_TAX_ENFORCE.
//   specified_premises  18% WITH input tax credit — restaurants inside
//                       higher-tariff hotel premises and those who opted in.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO: it does not infer a scheme from
// turnover, from a GSTIN, from the business category or from anything else,
// and it encodes no threshold and no notification number. Those move, they
// vary, and a wrong guess here would put a wrong rate on every bill. The
// owner declares the scheme; the UI points them at their CA for the edges.

const { query } = require('../config/db');

const REGULAR = 'regular';
const COMPOSITION = 'composition';
const SPECIFIED_PREMISES = 'specified_premises';

/** The only values `businesses.gst_scheme` may hold (see the 092 CHECK). */
const SCHEMES = [REGULAR, COMPOSITION, SPECIFIED_PREMISES];

/**
 * The GST slab a NEW menu item should default to under this scheme.
 *
 * Every value here is one of the slabs `menu_items.gst_pct` already allows
 * (migration 017's CHECK: 0, 5, 12, 18, 28), so nothing this returns can
 * violate the column constraint.
 *
 * An unknown / null / legacy value falls back to 5, i.e. exactly what the
 * hardcoded default did before this existed. Failing open to today's
 * behaviour is right: a scheme we cannot read must never silently zero
 * somebody's GST.
 */
function defaultGstPct(scheme) {
  switch (scheme) {
    case COMPOSITION: return 0;
    case SPECIFIED_PREMISES: return 18;
    default: return 5;
  }
}

/** True when this scheme means "charge the diner no GST, issue a bill of supply". */
function chargesNoGst(scheme) {
  return scheme === COMPOSITION;
}

/**
 * Read one business's declared scheme.
 *
 * TENANT SCOPE: `businessId` is the only row this can reach, and every caller
 * passes the ownership-checked path parameter.
 *
 * @param {string} businessId
 * @param {object} [client] run on an open transaction's client instead of the
 *   pool — required when called from inside withTransaction so the read sees
 *   the transaction's own snapshot (same convention as menuService.create).
 * @returns {Promise<string>} one of SCHEMES; 'regular' when the business is
 *   gone or the column is somehow null, so a missing answer never changes a
 *   rate.
 */
async function getScheme(businessId, client = null) {
  if (!businessId) return REGULAR;
  const run = client ? client.query.bind(client) : query;
  const r = await run(
    'SELECT gst_scheme FROM businesses WHERE id = $1 LIMIT 1',
    [businessId],
  );
  const v = r.rows[0] && r.rows[0].gst_scheme;
  return SCHEMES.includes(v) ? v : REGULAR;
}

/** Convenience: the menu default for a business, in one call. */
async function defaultGstPctFor(businessId, client = null) {
  return defaultGstPct(await getScheme(businessId, client));
}

module.exports = {
  REGULAR,
  COMPOSITION,
  SPECIFIED_PREMISES,
  SCHEMES,
  defaultGstPct,
  defaultGstPctFor,
  chargesNoGst,
  getScheme,
};
