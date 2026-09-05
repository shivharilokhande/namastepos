// NamastePOS — FEATURE DRIFT GUARD
//
// ══════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS
// ══════════════════════════════════════════════════════════════════════════
// On 2026-09-05 the founder removed Voice POS from the Enterprise plan in the
// admin console and the mic still appeared in a real customer's mobile app.
// The obvious explanation — a stale cache — was wrong. The real one is that
// `voice_pos` was gated by NOTHING: no route rule, no client check. Removing
// it in admin could not have changed anything, because nothing ever asked.
//
// That was the fourth instance of the same shape. Three earlier repairs are in
// git: FF-402's "restore-orphans" commits (inventory_tracking, memberships,
// reviews, marketplace_addons were enforced on live routes but missing from
// the admin catalog, so they could not be switched on at all), the 2026-09-03
// plans/addons audit (paid add-ons unlocked nothing because the addon slug was
// not the feature key, and per-business overrides were dead code), and
// dashboard_access (granted by migration 034, claimed to be "checked by app
// code", checked by nobody).
//
// Every one of those was found by a human reading two lists side by side.
// This file does that comparison mechanically, so the fifth one fails CI
// instead of arriving on a customer's phone.
//
// It is a pure library plus a CLI, deliberately the same shape as
// scripts/marketing-claims.js:
//
//   node scripts/feature-registry-audit.js          # human-readable report
//   node scripts/feature-registry-audit.js --json   # machine-readable
//   node scripts/feature-registry-audit.js --write  # regenerate the published
//                                                   # docs/feature-catalog.json
//
// Exit 0 = the registry, the gates, the clients and the plan data agree.
// Exit 1 = they do not, and each line names the key and what to do about it.
//
// The blocking gate is tests/integration/featureRegistryDrift.test.js.
//
// ══════════════════════════════════════════════════════════════════════════
// WHAT IT COMPARES
// ══════════════════════════════════════════════════════════════════════════
//   REGISTRY  src/config/featureRegistry.js — the declaration.
//   GATES     derived by scanning source, NOT declared: featureGate's
//             FEATURE_RULES, requireFeature('k'), hasFeature(bid, 'k'),
//             requireAddon(..., { orFeature: 'k' }), and the client-side
//             checks in the Flutter app and the owner dashboard.
//   DATA      every feature_key inserted by a migration, plus the pinned live
//             plan feed (tests/fixtures/plan-feed.json).
//
// Deriving the gates by scanning is the whole point. A declaration compared
// against another declaration proves nothing; this compares a declaration
// against the code that actually runs.

const fs = require('fs');
const path = require('path');

const registry = require('../src/config/featureRegistry');

const BACKEND = path.join(__dirname, '..');
const REPO = path.join(BACKEND, '..');
const MOBILE_DIR = path.join(REPO, 'namastepos_flutter', 'lib');
const DASHBOARD_DIR = path.join(REPO, 'namastepos_dashboard', 'src');
const PLAN_FEED = path.join(BACKEND, 'tests', 'fixtures', 'plan-feed.json');

// ══════════════════════════════════════════════════════════════════════════
// THE DEBT LIST
// ══════════════════════════════════════════════════════════════════════════
//
// Keys that are grantable in admin and enforced NOWHERE. Each one is a plan
// line the product does not keep, so each one needs a reason and an exit.
// The audit asserts this set EXACTLY: a key that becomes enforced must be
// removed from here (and promoted in the registry), and a key that loses its
// gate must be added here deliberately. Neither can happen by accident, which
// is the entire mechanism.
//
// The reasons live in the registry entries' `why` field — one place, not two.
// This is only the frozen membership list.
const UNENFORCED_DEBT = Object.freeze([
  'api_access', // no tenant API-key surface exists at all
  'customers_crm', // CRM screens are the directory screens; nothing branches
  'dashboard_access', // migration 034 sells it; nothing checks it
  'pos', // the product itself — deliberately never gated
  'staff_unlimited', // a CLAIM; the cap is plans.limits.staff
  'tables_multi_floor', // a CLAIM; the cap is plans.limits.floors
  'token_generation', // printed by the ordinary bill path; nothing to gate
  // voice_pos WAS here — the bug that started this audit. The mobile app now
  // gates the mic on the key (lib/constants/feature_keys.dart declares it
  // MobileSurface.gated) so it is enforced, and rule 3 below fires if the
  // gate is ever removed. Do not put it back without removing that gate.
  'white_label', // no white-label implementation exists
]);

// ══════════════════════════════════════════════════════════════════════════
// SOURCE SCANNING
// ══════════════════════════════════════════════════════════════════════════

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', 'ios', 'android']);

function walk(dir, exts, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, out);
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

/** Collect every capture-group-1 match of `re` across `files`, with location. */
function collect(files, patterns) {
  const found = new Map(); // key -> [ 'relative/path.js:12', … ]
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      // A commented-out gate is not a gate. featureGate.js keeps one on
      // purpose (the Push 13.7 tables_multi_floor rule) and counting it would
      // hide a real gap.
      const code = line.replace(/^\s*(\/\/|--|\/\*).*$/, '');
      for (const re of patterns) {
        for (const m of code.matchAll(re)) {
          const rel = path.relative(REPO, file);
          if (!found.has(m[1])) found.set(m[1], []);
          found.get(m[1]).push(`${rel}:${i + 1}`);
        }
      }
    });
  }
  return found;
}

/**
 * Feature keys the BACKEND enforces. Scanned, not declared:
 *   * FEATURE_RULES rows in middleware/featureGate.js
 *   * requireFeature('k') — both the imported form and the inline
 *     require('../middleware/requireFeature')('k') form, which an earlier
 *     hand-audit of this codebase missed
 *   * hasFeature(<anything>, 'k')
 *   * requireAddon(slug, { orFeature: 'k' })
 */
function scanServerGates() {
  const files = walk(path.join(BACKEND, 'src'), ['.js'])
    // The registry itself names every key; scanning it would make every key
    // look enforced and the audit would always pass. Same for the service that
    // merges them.
    .filter((f) => !f.endsWith(path.join('config', 'featureRegistry.js')))
    .filter((f) => !f.endsWith(path.join('services', 'featureService.js')));
  const found = collect(files, [
    // Both call shapes. The inline require(...)('key') form is not a stylistic
    // variant to ignore: routes/sprint1Extras.routes.js uses it, and a
    // hand-audit that only grepped for the imported form concluded
    // custom_branding was ungated when it is not.
    /requireFeature'?\s*\)?\s*\(\s*'([a-z_0-9]+)'/g,
    /hasFeature\s*\(\s*[^,()]+,\s*'([a-z_0-9]+)'/g,
    /orFeature:\s*'([a-z_0-9]+)'/g,
  ]);
  // FEATURE_RULES rows, scanned ONLY in featureGate.js. A bare `key: 'x'`
  // pattern across all of src matches ExcelJS column definitions and dunning
  // stage names, which would drown the real signal in noise — and a guard
  // that cries wolf gets switched off.
  const gateFile = path.join(BACKEND, 'src', 'middleware', 'featureGate.js');
  for (const [k, where] of collect([gateFile], [/\{\s*match:\s*'[^']*',\s*key:\s*'([a-z_0-9]+)'\s*\}/g])) {
    if (!found.has(k)) found.set(k, []);
    found.get(k).push(...where);
  }
  return found;
}

// The mobile app's own feature registry, added 2026-09-05 by the same audit
// that produced this file: lib/constants/feature_keys.dart holds a `Features`
// class of key constants and a `kMobileSurfaces` map recording, per key,
// whether the app has UI for it and whether that UI is gated.
//
// We read that DECLARATION rather than grepping Dart call sites, and the
// division of labour is what makes both halves stable:
//   * the app's own test/entitlements_test.dart asserts the declaration
//     against the real call sites — their half;
//   * this audit asserts the declaration against the backend registry —
//     ours.
// Neither side has to understand the other's call syntax, and a refactor of
// the Flutter widgets cannot turn this gate red for no reason.
const MOBILE_REGISTRY = path.join(MOBILE_DIR, 'constants', 'feature_keys.dart');

/**
 * Parse the mobile registry. Returns
 * `{ available: boolean, catalog: Set, gated: Map, ungated: Set, noSurface: Set }`.
 * `available:false` when the file is absent (an older checkout) — the caller
 * then falls back to a call-site scan rather than failing.
 */
function readMobileRegistry() {
  if (!fs.existsSync(MOBILE_REGISTRY)) return { available: false };
  const src = fs.readFileSync(MOBILE_REGISTRY, 'utf8');
  // `static const String kds = 'kds';` → identifier ↦ key
  const byIdent = new Map();
  for (const m of src.matchAll(/static\s+const\s+String\s+([A-Za-z0-9_]+)\s*=\s*'([a-z_0-9]+)'/g)) {
    byIdent.set(m[1], m[2]);
  }
  // `Features.kds: FeatureSurface(MobileSurface.gated, '…')`
  const gated = new Map();
  const ungated = new Set();
  const noSurface = new Set();
  const catalog = new Set();
  for (const m of src.matchAll(
    /Features\.([A-Za-z0-9_]+)\s*:\s*(?:const\s+)?FeatureSurface\(\s*MobileSurface\.([A-Za-z]+)/g,
  )) {
    const key = byIdent.get(m[1]);
    if (!key) continue;
    catalog.add(key);
    if (m[2] === 'gated') gated.set(key, [`namastepos_flutter/lib/constants/feature_keys.dart (${m[1]})`]);
    else if (m[2] === 'ungatedByDesign') ungated.add(key);
    else noSurface.add(key);
  }
  return { available: true, catalog, gated, ungated, noSurface };
}

/**
 * Feature keys the MOBILE app gates on. Prefers the app's declared registry
 * (above); falls back to grepping PlanGate / PlanInfo.has call sites when the
 * app predates it.
 */
function scanMobileGates() {
  const reg = readMobileRegistry();
  if (reg.available) return reg.gated;
  return collect(walk(MOBILE_DIR, ['.dart']), [
    /\bhas\(\s*'([a-z_0-9]+)'\s*\)/g,
    /featureKey:\s*'([a-z_0-9]+)'/g,
  ]);
}

/** Feature keys the owner DASHBOARD gates on (nav entries + usePlan().has). */
function scanDashboardGates() {
  return collect(walk(DASHBOARD_DIR, ['.ts', '.tsx']), [
    /\bfeature:\s*'([a-z_0-9]+)'/g,
    /\bhas(?:Feature)?\(\s*'([a-z_0-9]+)'\s*\)/g,
  ]);
}

/**
 * Feature keys present in the DATA: every plan_features row a migration
 * inserts, plus the pinned capture of the live plan feed. The live feed is the
 * important half — the five-plan ladder was built by the founder in the
 * console and exists only as production rows, so a key can be granted to real
 * customers without appearing in any migration.
 */
function scanData() {
  const found = new Map();
  const add = (k, where) => {
    if (!found.has(k)) found.set(k, []);
    found.get(k).push(where);
  };
  for (const file of walk(path.join(BACKEND, 'db'), ['.sql'])) {
    const sql = fs.readFileSync(file, 'utf8');
    if (!sql.includes('plan_features')) continue;
    const rel = path.relative(REPO, file);
    for (const m of sql.matchAll(/\(\s*'[a-z_0-9-]+'\s*,\s*'([a-z_0-9]+)'\s*\)/g)) add(m[1], rel);
  }
  if (fs.existsSync(PLAN_FEED)) {
    const feed = JSON.parse(fs.readFileSync(PLAN_FEED, 'utf8'));
    for (const p of feed.plans || []) {
      for (const k of p.featureKeys || []) add(k, `plan-feed.json (${p.name})`);
    }
  }
  return found;
}

// ══════════════════════════════════════════════════════════════════════════
// THE AUDIT
// ══════════════════════════════════════════════════════════════════════════

/**
 * The comparison itself — PURE. Takes the four scanned maps (key → where[]),
 * the registry entries and the debt list; returns violations. Nothing here
 * touches the filesystem.
 *
 * It is separated from audit() so the drift test can feed it a synthetic
 * codebase and prove each rule actually fires. A guard nobody has ever seen
 * fail is a guard nobody knows works — the marketing-claims guard learned the
 * same lesson.
 *
 * @param {object} o
 * @param {Array}  o.features    registry entries ({key,label,group,enforcement,…})
 * @param {Map}    o.server      backend gate key → source locations
 * @param {Map}    o.mobile      Flutter gate key → source locations
 * @param {Map}    o.dashboard   dashboard gate key → source locations
 * @param {Map}    o.data        plan_features key → where it is granted
 * @param {Array}  o.debt        keys allowed to be enforced nowhere
 * @param {Set}   [o.mobileCatalog] every key the Flutter app's own registry
 *                                  declares; omitted when the app predates it
 */
function compare({
  features, server, mobile, dashboard, data, debt: debtList, mobileCatalog = null,
}) {
  const registered = new Set(features.map((f) => f.key));
  const enforcedAnywhere = new Set([...server.keys(), ...mobile.keys(), ...dashboard.keys()]);
  const violations = [];
  const V = (kind, key, message, where) => violations.push({ kind, key, message, where: where || [] });

  // ── 1. ENFORCED BUT NOT GRANTABLE ──────────────────────────────────────
  // The founder's stated complaint. A gate on a key the admin picker does not
  // offer is a capability he cannot sell, price or switch off.
  for (const [key, where] of [...server, ...mobile, ...dashboard]) {
    if (registered.has(key)) continue;
    V('enforced-not-grantable', key,
      `'${key}' gates real behaviour but is not in src/config/featureRegistry.js, so it is `
      + 'absent from GET /v1/admin/feature-catalog and CANNOT BE GRANTED in the admin console. '
      + 'Add a registry entry.', where);
  }

  // ── 2. GRANTABLE BUT ENFORCED NOWHERE ──────────────────────────────────
  // Worse than 1: a plan line the product does not keep. Allowed only when
  // declared in UNENFORCED_DEBT, so the set can only change on purpose.
  const debt = new Set(debtList);
  for (const key of registered) {
    if (enforcedAnywhere.has(key)) continue;
    if (debt.has(key)) continue;
    V('grantable-not-enforced', key,
      `'${key}' can be granted to a plan but NOTHING enforces it — no route rule, no `
      + 'requireFeature, no mobile check, no dashboard check. Selling it delivers nothing. '
      + 'Add a gate, or add it to UNENFORCED_DEBT in scripts/feature-registry-audit.js with '
      + 'a reason in its registry entry.');
  }

  // ── 3. DEBT THAT IS NO LONGER DEBT ─────────────────────────────────────
  // The reverse direction, and the one that will catch the voice_pos fix:
  // when the mobile gate lands, this fires and asks for the promotion.
  for (const key of debtList) {
    if (!registered.has(key)) {
      V('stale-debt-entry', key,
        `'${key}' is listed in UNENFORCED_DEBT but is not a registered feature key. Remove it.`);
      continue;
    }
    if (!enforcedAnywhere.has(key)) continue;
    const where = [...(server.get(key) || []), ...(mobile.get(key) || []), ...(dashboard.get(key) || [])];
    V('debt-now-enforced', key,
      `'${key}' IS enforced now — remove it from UNENFORCED_DEBT and set its registry `
      + "enforcement to the real one ('route' / 'middleware' / 'service' / 'client').", where);
  }

  // ── 4. DECLARED ENFORCEMENT vs REALITY ─────────────────────────────────
  // A registry entry that claims a gate it does not have is a lie the next
  // reader will believe. This is what turns the registry from documentation
  // into a checked assertion.
  for (const entry of features) {
    const { key, enforcement } = entry;
    const inServer = server.has(key);
    const inMobile = mobile.has(key);
    const inDashboard = dashboard.has(key);
    if (['route', 'middleware', 'service'].includes(enforcement) && !inServer) {
      V('declared-server-gate-missing', key,
        `registry declares '${key}' as enforcement:'${enforcement}' but no backend gate `
        + 'references it. Either the gate was deleted (a paid feature just became free) or '
        + 'the declaration is wrong.');
    }
    if (enforcement === 'client') {
      const clients = entry.clients || [];
      if (clients.includes('mobile') && !inMobile) {
        V('declared-client-gate-missing', key,
          `registry declares '${key}' as gated in the MOBILE app but no check exists in `
          + 'namastepos_flutter/lib. This is exactly the voice_pos failure: the key is sold, '
          + 'the server has no surface to enforce it, and the client shows it to everyone.');
      }
      if (clients.includes('dashboard') && !inDashboard) {
        V('declared-client-gate-missing', key,
          `registry declares '${key}' as gated in the owner DASHBOARD but no check exists in `
          + 'namastepos_dashboard/src.');
      }
      if (!clients.length) {
        V('client-gate-unspecified', key,
          `registry declares '${key}' as enforcement:'client' without a \`clients\` list. `
          + "Name them: ['mobile'], ['dashboard'] or both.");
      }
    }
    if (enforcement === 'ungated' && !entry.why) {
      V('ungated-without-reason', key,
        `registry declares '${key}' as enforcement:'ungated' with no \`why\`. An unenforced `
        + 'plan line needs a reason and an exit, not silence.');
    }
  }

  // ── 5. DATA THAT NEITHER SIDE KNOWS ABOUT ──────────────────────────────
  // A plan_features row for a key nothing reads. It renders as granted on the
  // plan card and does nothing — an invisible promise.
  for (const [key, where] of data) {
    if (registered.has(key)) continue;
    V('data-not-registered', key,
      `'${key}' is granted to a plan in the data but is not a registered feature key, so `
      + 'nothing reads it and no admin screen explains it. Register it or remove the grant.',
    [...new Set(where)].slice(0, 4));
  }

  // ── 6. THE MOBILE APP'S REGISTRY MUST BE THE SAME REGISTRY ─────────────
  // "each plan should be properly synced and working according to that only
  // in dashboard and mobile app both." The app carries its own list of keys
  // (lib/constants/feature_keys.dart) because Dart cannot import a JS module;
  // that list is a MIRROR, not a second source of truth, and a mirror nobody
  // checks is how two lists become two products. So: same set, both ways.
  if (mobileCatalog) {
    for (const key of registered) {
      if (mobileCatalog.has(key)) continue;
      V('mobile-catalog-missing-key', key,
        `'${key}' is a registered backend feature key but the mobile app's registry `
        + '(namastepos_flutter/lib/constants/feature_keys.dart) does not list it. The app '
        + 'cannot gate — or even name — a key it does not know. Add it there with its '
        + 'MobileSurface, or remove it here.');
    }
    for (const key of mobileCatalog) {
      if (registered.has(key)) continue;
      V('mobile-catalog-extra-key', key,
        `the mobile app's registry lists '${key}' but it is not in `
        + 'src/config/featureRegistry.js, so the admin console cannot grant it and no plan '
        + 'will ever carry it. Register it on the backend, or drop it from the app.');
    }
  }

  return violations;
}

/**
 * Scan the real source tree and compare it to the real registry.
 * Returns { violations, sets }; every violation is `{ kind, key, message,
 * where }` and `message` is written to be actionable on its own, because a CI
 * log line is all the reader gets.
 */
function audit() {
  const server = scanServerGates();
  const mobileReg = readMobileRegistry();
  const mobile = scanMobileGates();
  const dashboard = scanDashboardGates();
  const data = scanData();
  const violations = compare({
    features: registry.FEATURES,
    server,
    mobile,
    dashboard,
    data,
    debt: UNENFORCED_DEBT,
    mobileCatalog: mobileReg.available ? mobileReg.catalog : null,
  });
  return {
    violations,
    sets: {
      registry: registry.keys(),
      server: [...server.keys()].sort(),
      mobile: [...mobile.keys()].sort(),
      dashboard: [...dashboard.keys()].sort(),
      data: [...data.keys()].sort(),
      unenforcedDebt: [...UNENFORCED_DEBT],
      mobileRegistry: mobileReg.available ? [...mobileReg.catalog].sort() : null,
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════
// THE PUBLISHED CATALOG
// ══════════════════════════════════════════════════════════════════════════
//
// docs/feature-catalog.json is the registry rendered as data, committed so
// that consumers which cannot require() a Node module — the Flutter app's
// entitlement test, a CI shell step, anything outside this repo — have ONE
// stable file to read instead of regexing a JavaScript source file. (The
// mobile app's registry header points at featureService.js's old
// WELL_KNOWN_FEATURE_KEYS array; that array no longer exists, and this is
// what replaces it.)
//
// It is generated, never hand-edited: `--write` regenerates it and the
// blocking test fails when it is stale, exactly as a snapshot should.
const PUBLISHED = path.join(BACKEND, 'docs', 'feature-catalog.json');

/** The registry as committed JSON. Stable key order so diffs stay readable. */
function publishedCatalog() {
  return {
    _comment: 'GENERATED — do not edit. Source: src/config/featureRegistry.js. '
      + 'Regenerate with `node scripts/feature-registry-audit.js --write`.',
    groups: [...registry.GROUPS],
    features: registry.FEATURES.map((f) => ({
      key: f.key,
      label: f.label,
      group: f.group,
      enforcement: f.enforcement,
      ...(f.clients ? { clients: [...f.clients] } : {}),
    })),
  };
}

function publishedCatalogJson() {
  return `${JSON.stringify(publishedCatalog(), null, 2)}\n`;
}

/** null when the committed file matches the registry, else why it does not. */
function publishedCatalogDrift() {
  if (!fs.existsSync(PUBLISHED)) {
    return 'docs/feature-catalog.json is missing. Run '
      + '`node scripts/feature-registry-audit.js --write`.';
  }
  const onDisk = fs.readFileSync(PUBLISHED, 'utf8');
  if (onDisk === publishedCatalogJson()) return null;
  return 'docs/feature-catalog.json is stale — it no longer matches '
    + 'src/config/featureRegistry.js. Run `node scripts/feature-registry-audit.js --write` '
    + 'and commit the result.';
}

/** One line per violation, ready for a CI log. */
function format(violations) {
  return violations.map((v) => {
    const where = v.where.length ? `\n      seen at: ${v.where.slice(0, 4).join(', ')}` : '';
    return `  [${v.kind}] ${v.message}${where}`;
  }).join('\n');
}

module.exports = {
  audit,
  compare,
  format,
  PUBLISHED,
  publishedCatalogJson,
  publishedCatalogDrift,
  readMobileRegistry,
  UNENFORCED_DEBT,
  scanServerGates,
  scanMobileGates,
  scanDashboardGates,
  scanData,
};

// ── CLI ──────────────────────────────────────────────────────────────────
if (require.main === module) {
  /* eslint-disable no-console */
  if (process.argv.includes('--write')) {
    fs.mkdirSync(path.dirname(PUBLISHED), { recursive: true });
    fs.writeFileSync(PUBLISHED, publishedCatalogJson());
    console.log(`feature-registry-audit: wrote ${path.relative(BACKEND, PUBLISHED)}`);
  }
  const { violations, sets } = audit();
  const stale = publishedCatalogDrift();
  if (stale) violations.push({ kind: 'published-catalog-stale', key: '-', message: stale, where: [] });
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ok: violations.length === 0, violations, sets }, null, 2));
  } else if (violations.length === 0) {
    console.log(`feature-registry-audit: OK — ${sets.registry.length} registered keys; `
      + `${sets.server.length} server-gated, ${sets.mobile.length} mobile-gated, `
      + `${sets.dashboard.length} dashboard-gated, ${sets.unenforcedDebt.length} declared unenforced.`);
  } else {
    console.error(`feature-registry-audit: ${violations.length} violation(s)\n${format(violations)}`);
  }
  /* eslint-enable no-console */
  process.exit(violations.length === 0 ? 0 : 1);
}
