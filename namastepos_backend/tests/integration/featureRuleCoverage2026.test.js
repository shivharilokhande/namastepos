// FEATURE RULE COVERAGE — every featureGate rule must gate a real route.
//
// ══════════════════════════════════════════════════════════════════════════
// WHY (2026-09-05, entitlements review B10)
// ══════════════════════════════════════════════════════════════════════════
// middleware/featureGate.js gates by SUBSTRING: `{ match: '/captain/', key:
// 'captain_mode' }` fires when req.path contains '/captain/'. No route has
// ever had that path. Ten rules in the table were like it — '/qr-codes',
// '/whatsapp', '/recurring-invoice', '/marketplace', '/fx-rates', … — and
// the registry declared each of their keys `enforcement: 'route'`. The drift
// audit (scripts/feature-registry-audit.js) scans featureGate.js for rule
// rows and counted every one as proof of enforcement, so seven paid features
// passed CI as "gated" while every plan could reach them: Starter could
// create and RUN WhatsApp campaigns, split bills, read FX rates.
//
// The audit runs without env or a database, so it cannot build the Express
// app. This test can. It walks the mounted router stack, enumerates every
// registered path under /v1/businesses/:businessId — the prefix the gate is
// mounted on — and asserts:
//
//   (a) every FEATURE_RULES row is the rule requiredFeature() actually
//       returns for at least one registered path (so a rule cannot be dead,
//       and cannot be fully shadowed by an earlier rule either);
//   (b) every registry key declared enforcement:'route' is returned by
//       requiredFeature() for at least one registered path;
//   (c) the ten historical dead match strings still match nothing — i.e.
//       re-adding any of them would fail (a), which is the proof this test
//       has teeth.
//
// No database. buildApp() only wires middleware; nothing here sends a request.

const buildApp = require('../../src/app');
const featureGate = require('../../src/middleware/featureGate');
const registry = require('../../src/config/featureRegistry');
const env = require('../../src/config/env');

const GATE_PREFIX = `${env.API_PREFIX}/businesses/:businessId`;

/**
 * Recover the mount path string from an Express 4 `app.use(path, router)`
 * layer. Express keeps only the compiled regexp, e.g.
 *   /^\/v1\/businesses(?:\/([^\/]+?))\/menu\/?(?=\/|$)/i
 * Each `(?:\/([^\/]+?))` is one of `layer.keys`, in order (the leading slash
 * is inside the group). Anything we cannot decode is returned as null and
 * reported, never silently skipped.
 */
function mountPathOf(layer) {
  if (layer.regexp?.fast_slash) return '';
  let src = layer.regexp.source;
  // Strip the anchors Express adds for a mount: '^' … '\/?(?=\/|$)'.
  src = src.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '');
  const keys = layer.keys || [];
  let i = 0;
  // `[^\/]` may be serialised with or without the inner backslash depending
  // on the path-to-regexp version, so accept both.
  src = src.replace(/\(\?:\\\/\(\[\^\\?\/\]\+\?\)\)/g, () => {
    const k = keys[i++];
    return `/:${k ? k.name : 'param'}`;
  });
  if (/[()[\]?+*|]/.test(src.replace(/\\\//g, '/'))) return null; // still regexy
  return src.replace(/\\\//g, '/');
}

/** Every (method, path) registered on `router`, prefixed by `prefix`. */
function walk(router, prefix, out, undecodable) {
  for (const layer of router.stack || []) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const p of paths) {
        // A router's own '/' is the mount itself (req.path '/menu', not '/menu/').
        const full = p === '/' ? (prefix || '/') : `${prefix}${p}`;
        for (const m of Object.keys(layer.route.methods)) {
          out.push({ method: m.toUpperCase(), path: full });
        }
      }
    } else if (layer.handle && layer.handle.stack) {
      const mount = mountPathOf(layer);
      if (mount === null) {
        undecodable.push(String(layer.regexp));
        continue;
      }
      walk(layer.handle, `${prefix}${mount}`, out, undecodable);
    }
  }
}

function registeredRoutes() {
  const app = buildApp();
  const out = [];
  const undecodable = [];
  walk(app._router, '', out, undecodable);
  return { routes: out, undecodable };
}

describe('featureGate FEATURE_RULES cover real routes (B10)', () => {
  let all;
  let gated; // relative paths under the gate's mount, as req.path sees them
  let undecodable;

  beforeAll(() => {
    ({ routes: all, undecodable } = registeredRoutes());
    gated = [...new Set(
      all
        .filter((r) => r.path.startsWith(GATE_PREFIX))
        .map((r) => r.path.slice(GATE_PREFIX.length) || '/'),
    )];
  });

  it('enumerated the router without losing a mount', () => {
    // A mount we could not decode would hide its routes from every assertion
    // below and turn this file into the very rubber stamp it replaces.
    expect(undecodable).toEqual([]);
    // Sanity floor: the business API is large. If this drops, the walker
    // broke, not the product.
    expect(gated.length).toBeGreaterThan(150);
    expect(gated).toContain('/menu');
    expect(gated).toContain('/sessions/:sessionId/split');
  });

  it('(a) every FEATURE_RULES row is the effective rule for at least one registered route', () => {
    const dead = [];
    for (const rule of featureGate.FEATURE_RULES) {
      const hit = gated.find(
        (p) => p.includes(rule.match) && featureGate.requiredFeature(p) === rule.key,
      );
      if (!hit) dead.push(`{ match: '${rule.match}', key: '${rule.key}' }`);
    }
    if (dead.length) {
      throw new Error(
        `${dead.length} featureGate rule(s) match NO registered route under ${GATE_PREFIX} `
        + '(or are shadowed by an earlier rule). A dead rule makes the registry claim a gate '
        + 'that does not exist, and the feature it names is open to every plan:\n  '
        + `${dead.join('\n  ')}\n`
        + 'Fix the match string to the real path (grep src/routes), or delete the rule and '
        + "change the key's registry enforcement to what is actually true.",
      );
    }
    expect(dead).toEqual([]);
  });

  it("(b) every registry key declared enforcement:'route' gates at least one registered route", () => {
    const routeKeys = registry.keysWithEnforcement('route');
    const reached = new Set(gated.map((p) => featureGate.requiredFeature(p)).filter(Boolean));
    const unenforced = routeKeys.filter((k) => !reached.has(k));
    if (unenforced.length) {
      throw new Error(
        `registry declares [${unenforced.join(', ')}] as enforcement:'route' but `
        + 'featureGate.requiredFeature() never returns them for any registered route. '
        + 'Add a rule that matches the implementing route, or change the declaration to '
        + "'client' / 'service' / 'ungated' (with a why).",
      );
    }
    expect(unenforced).toEqual([]);
  });

  it('(c) the historical dead match strings still match nothing — so re-adding one fails (a)', () => {
    // These are the exact strings that sat in FEATURE_RULES until 2026-09-05.
    // If any of them ever DOES match a route, that is fine — but then it is
    // also fine to gate it, and this list should be updated deliberately.
    //
    // 2026-09-06 (round 2, CONTRACTS §2): '/recurring-invoice' left this list
    // deliberately — recurring invoices were BUILT (routes/recurringInvoices
    // .routes.js at '/recurring-invoices') and the live rule
    // { match: '/recurring-invoices', key: 'recurring_invoices' } is asserted
    // by (a)/(b) above and pinned in the expectations block below.
    const historicalDead = [
      '/captain/', '/qr-codes', '/whatsapp', '/marketplace',
      '/fx-rates', '/recipes', '/heat-map', '/outlets', '/multi-outlet',
    ];
    const nowLive = historicalDead.filter((m) => gated.some((p) => p.includes(m)));
    expect(nowLive).toEqual([]);
    // And the assertion in (a) really would reject one of them:
    const fakeRule = { match: '/captain/', key: 'captain_mode' };
    const hit = gated.find((p) => p.includes(fakeRule.match));
    expect(hit).toBeUndefined();
  });

  it('the repaired rules land on the routes they were meant for', () => {
    // The seven B-series fixes, pinned to the real paths so a later route
    // rename shows up here with the feature name attached.
    const expectations = {
      '/wa/campaigns': 'whatsapp_marketing',
      '/wa/campaigns/:id/run': 'whatsapp_marketing',
      '/sessions/:sessionId/split': 'bill_split',
      '/sessions/:sessionId/splits': 'bill_split',
      '/bill-split-invoices/:id/pay': 'bill_split',
      '/ops/qr/settings': 'qr_ordering',
      '/ops/tables/:tableId/qr': 'qr_ordering',
      '/ops/tables/:tableId/qr/rotate': 'qr_ordering',
      '/fx/:base/:quote': 'multi_currency_fx',
      '/orders/:orderId/assign-driver': 'driver_mode',
      // 2026-09-06 (round 2): recurring invoices built — CRUD + run-now.
      '/recurring-invoices': 'recurring_invoices',
      '/recurring-invoices/:id/run-now': 'recurring_invoices',
    };
    for (const [path, key] of Object.entries(expectations)) {
      expect(gated).toContain(path);
      expect(featureGate.requiredFeature(path)).toBe(key);
    }
    // …and the broader match strings did not swallow a Starter path.
    for (const open of ['/wastage', '/wait-list', '/sessions/:sessionId', '/menu', '/orders', '/ops/tables']) {
      if (!gated.includes(open)) continue;
      expect(['whatsapp_marketing', 'bill_split', 'qr_ordering', 'multi_currency_fx'])
        .not.toContain(featureGate.requiredFeature(open));
    }
  });

  it('/addons stays exempt whatever the rules say', () => {
    expect(featureGate.requiredFeature('/addons/whatsapp-marketing/confirm-payment')).toBeNull();
  });
});
