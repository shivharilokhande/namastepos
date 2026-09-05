// FEATURE DRIFT GUARD — the blocking gate.
//
// ══════════════════════════════════════════════════════════════════════════
// WHAT THIS PROTECTS
// ══════════════════════════════════════════════════════════════════════════
// The founder's requirement, verbatim:
//   "every features should be in admin to add it in plans, and each plan
//    should be properly synced and working according to that only in
//    dashboard and mobile app both."
//
// Three sets have to be the same set, and for a year they were three
// hand-maintained lists that drifted apart every time somebody shipped:
//   (a) what the backend ENFORCES
//   (b) what admin can GRANT
//   (c) what the plan DATA carries
//
// The bug that triggered this audit: Voice POS was removed from Enterprise in
// the admin console and the mic still appeared on a real customer's phone,
// because `voice_pos` was gated by nothing at all — no route rule, no client
// check. Nothing had ever asked whether the key did anything.
//
// This file asks, on every CI run. It is the same pin-and-compare shape as
// tests/integration/marketingClaims.test.js, which does the same job for
// marketing copy against the plan feed.
//
// ══════════════════════════════════════════════════════════════════════════
// HOW IT FAILS
// ══════════════════════════════════════════════════════════════════════════
// The message names the key, what is wrong with it and what to do — because a
// CI log line is all the next reader gets. Example, from the case that
// started this:
//
//   [declared-client-gate-missing] registry declares 'voice_pos' as gated in
//   the MOBILE app but no check exists in namastepos_flutter/lib. This is
//   exactly the voice_pos failure: the key is sold, the server has no surface
//   to enforce it, and the client shows it to everyone.
//
// The second half of the file proves each rule actually fires, by running the
// pure comparison over a synthetic codebase. A guard nobody has ever watched
// fail is a guard nobody knows works.

const { query } = require('../../src/config/db');
const { resetDb } = require('../setup');
const guard = require('../../scripts/feature-registry-audit');
const registry = require('../../src/config/featureRegistry');
const features = require('../../src/services/featureService');
const featureGate = require('../../src/middleware/featureGate');

/** Build the { key -> locations } map shape `compare` consumes. */
const gates = (...keys) => new Map(keys.map((k) => [k, [`synthetic:${k}`]]));

describe('feature registry — the enforced / grantable / granted sets agree', () => {
  it('the live source tree has no feature drift', () => {
    const { violations, sets } = guard.audit();
    if (violations.length) {
      throw new Error(
        `${violations.length} feature-drift violation(s). Each one means the founder cannot `
        + 'control a capability he is selling, or is selling one the product does not deliver.\n'
        + `${guard.format(violations)}\n\n`
        + `registry=${sets.registry.length} server-gated=${sets.server.length} `
        + `mobile-gated=${sets.mobile.length} dashboard-gated=${sets.dashboard.length} `
        + `declared-unenforced=${sets.unenforcedDebt.length}\n`
        + 'Run `node scripts/feature-registry-audit.js` for the same report locally.',
      );
    }
    expect(violations).toEqual([]);
  });

  it('every key featureGate gates is a registered key', () => {
    // featureGate throws at require() if this is false, so reaching this line
    // is already most of the proof; the explicit assertion states the contract
    // for anyone reading the test rather than the middleware.
    const gated = ['/kds/', '/loyalty', '/outlets', '/einvoice', '/tds-tcs']
      .map((p) => featureGate.requiredFeature(p));
    for (const key of gated) {
      expect(registry.isKnown(key)).toBe(true);
    }
  });

  it('the published docs/feature-catalog.json is not stale', () => {
    // The registry rendered as data, committed so that consumers which cannot
    // require() a Node module — the Flutter entitlement test, a CI shell step —
    // have one stable file to read. Regenerate with
    //   node scripts/feature-registry-audit.js --write
    const stale = guard.publishedCatalogDrift();
    expect(stale).toBeNull();
  });

  it('the mobile app knows exactly the keys the backend registers', () => {
    // Dart cannot import a JS module, so the app carries its own copy in
    // lib/constants/feature_keys.dart. A copy nobody checks is how two lists
    // become two products; this is the check. (Skipped only if the app has no
    // registry yet — an older checkout.)
    const mobileReg = guard.readMobileRegistry();
    if (!mobileReg.available) return;
    expect([...mobileReg.catalog].sort()).toEqual(registry.keys());
  });

  it('every registered key carries a label, a known group and an enforcement kind', () => {
    const kinds = ['route', 'middleware', 'service', 'client', 'ungated'];
    for (const f of registry.FEATURES) {
      expect(typeof f.label).toBe('string');
      expect(f.label.length).toBeGreaterThan(0);
      expect(registry.GROUPS).toContain(f.group);
      expect(kinds).toContain(f.enforcement);
    }
    // No duplicate keys — a duplicate would make one entry silently unreachable.
    const keys = registry.FEATURES.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('feature registry — the admin console can grant every registered key', () => {
  beforeAll(async () => {
    await resetDb();
  });

  it('GET /admin/feature-catalog offers the whole registry', async () => {
    // This is the founder's stated complaint reduced to one assertion: a key
    // the product enforces but the catalog omits is a key he cannot switch on
    // or off, whatever the admin UI looks like.
    const catalog = new Set(await features.listFeatureCatalog());
    const missing = registry.keys().filter((k) => !catalog.has(k));
    expect(missing).toEqual([]);
  });

  it('the detailed catalog carries the label + group the console renders', async () => {
    const rows = await features.listFeatureCatalogDetailed();
    const byKey = new Map(rows.map((r) => [r.key, r]));
    for (const f of registry.FEATURES) {
      expect(byKey.get(f.key)).toMatchObject({
        key: f.key, label: f.label, group: f.group, enforcement: f.enforcement,
      });
    }
  });

  it('a plan_features key with no registry entry is surfaced, not hidden', async () => {
    // A stale grant left by an old deploy must stay visible in the console so
    // it can be removed. Invisible grants are how plan cards end up claiming
    // capabilities nothing implements.
    await query(
      "INSERT INTO plan_features (tier_kind, feature_key) VALUES ('free', 'ghost_feature_key')"
      + ' ON CONFLICT DO NOTHING',
    );
    try {
      const rows = await features.listFeatureCatalogDetailed();
      const ghost = rows.find((r) => r.key === 'ghost_feature_key');
      expect(ghost).toBeDefined();
      expect(ghost.enforcement).toBe('unregistered');
      // …and it is grantable/removable, i.e. present in the flat catalog too.
      expect(await features.listFeatureCatalog()).toContain('ghost_feature_key');
    } finally {
      await query("DELETE FROM plan_features WHERE feature_key = 'ghost_feature_key'");
      features.clearAllCaches();
    }
  });
});

describe('feature registry — the live plan feed grants only registered keys', () => {
  it('every featureKey in the pinned production feed is registered', () => {
    // The five-plan ladder was built by the founder in the console and exists
    // only as production rows, so a key can reach real customers without ever
    // appearing in a migration. tests/fixtures/plan-feed.json is the pinned
    // capture of that live feed; marketingClaims.test.js explains the pin.
    // eslint-disable-next-line global-require
    const feed = require('../fixtures/plan-feed.json');
    const unregistered = [];
    for (const plan of feed.plans) {
      for (const key of plan.featureKeys || []) {
        if (!registry.isKnown(key)) unregistered.push(`${plan.name}: ${key}`);
      }
    }
    expect(unregistered).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// THE GUARD ITSELF — proof each rule fires
// ══════════════════════════════════════════════════════════════════════════
describe('feature drift guard — each rule actually catches its failure', () => {
  const base = {
    features: [{ key: 'kds', label: 'KDS', group: 'Kitchen & ops', enforcement: 'route' }],
    server: gates('kds'),
    mobile: new Map(),
    dashboard: new Map(),
    data: gates('kds'),
    debt: [],
  };

  it('is silent when everything agrees', () => {
    expect(guard.compare(base)).toEqual([]);
  });

  it('catches a gate on a key admin cannot grant (the founder\'s complaint)', () => {
    const v = guard.compare({ ...base, server: gates('kds', 'secret_feature') });
    expect(v.map((x) => x.kind)).toContain('enforced-not-grantable');
    expect(v.find((x) => x.key === 'secret_feature').message).toMatch(/CANNOT BE GRANTED/);
  });

  it('catches a key that is grantable but enforced nowhere (sold, not delivered)', () => {
    const v = guard.compare({
      ...base,
      features: [...base.features, { key: 'ghost', label: 'Ghost', group: 'Advanced', enforcement: 'route' }],
    });
    expect(v.map((x) => x.kind)).toContain('grantable-not-enforced');
  });

  it('allows an unenforced key ONLY when it is on the declared debt list', () => {
    const withGhost = {
      ...base,
      features: [...base.features, { key: 'ghost', label: 'Ghost', group: 'Advanced', enforcement: 'ungated', why: 'x' }],
    };
    expect(guard.compare({ ...withGhost, debt: [] }).map((x) => x.kind))
      .toContain('grantable-not-enforced');
    expect(guard.compare({ ...withGhost, debt: ['ghost'] })).toEqual([]);
  });

  it('catches a debt entry that has since become enforced (the voice_pos fix landing)', () => {
    const v = guard.compare({
      ...base,
      features: [...base.features, { key: 'ghost', label: 'Ghost', group: 'Advanced', enforcement: 'ungated', why: 'x' }],
      mobile: gates('ghost'),
      debt: ['ghost'],
    });
    expect(v.map((x) => x.kind)).toContain('debt-now-enforced');
  });

  it('catches a registry entry claiming a server gate it does not have', () => {
    const v = guard.compare({ ...base, server: new Map(), mobile: gates('kds') });
    expect(v.map((x) => x.kind)).toContain('declared-server-gate-missing');
  });

  it('catches a MOBILE gate that was declared and then removed — the voice_pos shape', () => {
    // Someone deletes the mic's PlanGate. The server has no route to 402, so
    // nothing else in the system would ever notice. This does.
    const v = guard.compare({
      ...base,
      features: [{ key: 'voice_pos', label: 'Voice POS', group: 'Kitchen & ops', enforcement: 'client', clients: ['mobile'] }],
      server: new Map(),
      mobile: new Map(),
      data: gates('voice_pos'),
    });
    const hit = v.find((x) => x.kind === 'declared-client-gate-missing');
    expect(hit).toBeDefined();
    expect(hit.message).toMatch(/no check exists in namastepos_flutter\/lib/);
  });

  it('catches a dashboard gate that was declared and then removed', () => {
    const v = guard.compare({
      ...base,
      features: [{ key: 'orders', label: 'Orders', group: 'Core', enforcement: 'client', clients: ['dashboard'] }],
      server: new Map(),
      data: gates('orders'),
    });
    expect(v.map((x) => x.kind)).toContain('declared-client-gate-missing');
  });

  it("refuses an 'ungated' entry with no stated reason", () => {
    const v = guard.compare({
      ...base,
      features: [{ key: 'ghost', label: 'Ghost', group: 'Advanced', enforcement: 'ungated' }],
      server: new Map(),
      data: new Map(),
      debt: ['ghost'],
    });
    expect(v.map((x) => x.kind)).toContain('ungated-without-reason');
  });

  it('catches plan data granting a key neither side knows about', () => {
    const v = guard.compare({ ...base, data: gates('kds', 'orphan_key') });
    const hit = v.find((x) => x.kind === 'data-not-registered');
    expect(hit.key).toBe('orphan_key');
  });

  it('catches a debt entry for a key that no longer exists', () => {
    const v = guard.compare({ ...base, debt: ['deleted_key'] });
    expect(v.map((x) => x.kind)).toContain('stale-debt-entry');
  });
});
