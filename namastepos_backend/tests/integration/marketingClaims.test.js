// MARKETING CLAIM GUARD — the blocking gate.
//
// ══════════════════════════════════════════════════════════════════════════
// WHY THE PLAN DATA COMES FROM A PINNED SNAPSHOT REPLAYED THROUGH THE DB
// ══════════════════════════════════════════════════════════════════════════
// Three sourcing options, and only one of them is both correct and stable:
//
//   (a) Seed from migrations and read listPlans().
//       WRONG DATA. The migrations seed a legacy THREE-plan ladder
//       (free / basic / pro) in which `basic` is named "Pro" at Rs 299 and
//       there is no Growth and no Advanced at all. The live five-plan ladder
//       was built by the founder in the super-admin console, so it exists
//       only as rows in the production database. A test seeded from
//       migrations would be comparing the site against plans that do not
//       exist, and would pass while the site lied.
//
//   (b) Fetch https://api.namastepos.in/v1/public/plans inside the test.
//       RIGHT DATA, FLAKY GATE. The API is on a free tier that cold-starts,
//       and a blocking test that needs the internet fails for reasons that
//       have nothing to do with the change under review. A gate that goes
//       red at random is a gate people learn to re-run instead of read.
//
//   (c) THIS FILE. tests/fixtures/plan-feed.json is a pinned capture of that
//       live endpoint. The test writes it into the `plans` and
//       `plan_features` tables and then reads it back through
//       subscriptionService.listPlans() + featureService.listTierFeatures()
//       — the exact two calls GET /v1/public/plans composes in src/app.js.
//       So the copy is checked against the same serializer, the same limits
//       shape and the same feature-key join the marketing site consumes: a
//       change to serializePlan, to the plan_features lookup or to the
//       limits keys breaks this test too, not just a change to the copy.
//
// This is the same pin-plus-advisory shape as the mobile job: (c) is the
// hermetic blocking gate, and the `marketing-claims-live` CI job re-runs the
// SAME checker against production to catch a super-admin plan edit that
// arrives without a code change. When that advisory job goes red, refresh
// the snapshot and the copy together, deliberately.

const fs = require('fs');
const path = require('path');
const { query } = require('../../src/config/db');
const { resetDb } = require('../setup');
const subscriptions = require('../../src/services/subscriptionService');
const features = require('../../src/services/featureService');
const guard = require('../../scripts/marketing-claims');

const SNAPSHOT = JSON.parse(fs.readFileSync(guard.SNAPSHOT, 'utf8')).plans;

/** Write the pinned feed into the tables the API reads. */
async function seedPlanFeed(plans) {
  await query('DELETE FROM plan_features');
  await query('DELETE FROM plans');
  for (const p of plans) {
    await query(
      `INSERT INTO plans (tier, tier_kind, name, price_inr_paise, price_yearly_paise,
                          is_active, is_public, limits, features)
       VALUES ($1, $2, $3, $4, $5, TRUE, TRUE, $6, $7)`,
      [
        p.tier, p.tierKind, p.name,
        Math.round((p.priceInr || 0) * 100),
        p.priceYearlyInr == null ? null : Math.round(p.priceYearlyInr * 100),
        JSON.stringify(p.limits || {}),
        JSON.stringify(p.features || {}),
      ],
    );
    for (const key of p.featureKeys || []) {
      // plan_features.tier_kind holds a plan tier CODE, not a kind — see the
      // COMMENT ON COLUMN in migration 081 and the note in planTiers.js.
      await query(
        'INSERT INTO plan_features (tier_kind, feature_key) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [p.tier, key],
      );
    }
  }
}

/** Rebuild the /v1/public/plans payload the way src/app.js does. */
async function readFeedThroughTheApi() {
  const plans = await subscriptions.listPlans();
  return Promise.all(plans.map(async (p) => ({
    tier: p.tier,
    tierKind: p.tierKind,
    name: p.name,
    priceInr: p.priceInr,
    priceYearlyInr: p.priceYearlyInr,
    limits: p.limits || {},
    features: p.features || {},
    featureKeys: await features.listTierFeatures(p.tier, p.tierKind),
  })));
}

describe('marketing claims vs the plan feed', () => {
  let feed;

  beforeAll(async () => {
    await resetDb();
    await seedPlanFeed(SNAPSHOT);
    feed = await readFeedThroughTheApi();
  });

  it('serves the pinned ladder back through listPlans() unchanged', () => {
    // If this fails, the SERIALIZER changed (or the snapshot is malformed) —
    // fix that before reading anything into the claim failures below.
    expect(feed.map((p) => `${p.name}:${p.priceInr}`)).toEqual(
      SNAPSHOT.map((p) => `${p.name}:${p.priceInr}`),
    );
    expect(feed.every((p) => p.featureKeys.length > 0)).toBe(true);
  });

  it('the landing site makes no claim the plan feed contradicts', () => {
    const claims = guard.collectClaims(feed);
    // A parser that silently matched nothing would pass forever. It must not.
    expect(claims.length).toBeGreaterThan(150);
    const violations = guard.checkClaims(feed, claims);
    expect(guard.formatReport(violations, claims, feed)).toContain('OK');
    expect(violations).toEqual([]);
  });

  it('reads every commercial page, not just index.html', () => {
    const claims = guard.collectClaims(feed);
    const filesSeen = new Set(claims.map((c) => c.file));
    for (const f of guard.PAGES) expect(filesSeen.has(f)).toBe(true);
    expect(filesSeen.has('llms.txt')).toBe(true);
  });

  // ────────────────────────────────────────────────────────────────────────
  // The guard has to be able to FAIL. Each case below reintroduces one of the
  // four bugs of 2026-09-05 into a COPY of the landing site in a temp dir and
  // asserts the checker catches it and names it well enough to act on.
  // ────────────────────────────────────────────────────────────────────────
  describe('catches the bugs it was built for', () => {
    let tmp;

    beforeAll(() => {
      tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'np-claims-'));
      for (const f of [...guard.PAGES, 'llms.txt']) {
        fs.copyFileSync(path.join(guard.LANDING_DIR, f), path.join(tmp, f));
      }
    });

    afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

    const breakFile = (file, from, to) => {
      const p = path.join(tmp, file);
      const src = fs.readFileSync(p, 'utf8');
      expect(src).toContain(from); // the copy moved — update this test with it
      // split/join, not replace(): several of these strings appear twice (the
      // visible copy and its JSON-LD FAQ twin) and only breaking one of them
      // can land the edit somewhere no parser looks.
      fs.writeFileSync(p, src.split(from).join(to));
      return () => fs.writeFileSync(p, src);
    };

    const violationsNow = () => guard.checkClaims(feed, guard.collectClaims(feed, tmp));

    it('bug 2 — "Unlimited staff" on a plan capped at 10', () => {
      const undo = breakFile('index.html', '<td>Staff logins</td><td>1</td><td>5</td><td>10</td>', '<td>Staff logins</td><td>1</td><td>5</td><td>Unlimited</td>');
      const v = violationsNow();
      undo();
      expect(v).toHaveLength(1);
      expect(v[0].plan).toBe('Pro');
      expect(v[0].message).toContain('copy calls staff UNLIMITED on Pro');
      expect(v[0].message).toContain('Pro.limits.staff = 10');
    });

    it('bug 1 — GST tax invoices promised on Growth', () => {
      const undo = breakFile('index.html', 'Everything in Starter</li><li>', 'Everything in Starter</li><li>GST tax invoices</li><li>');
      const v = violationsNow();
      undo();
      expect(v.some((x) => x.plan === 'Growth'
        && /attributes "tax_invoices" to Growth/.test(x.message)
        && /Plans with it: Pro, Advanced, Enterprise/.test(x.message))).toBe(true);
    });

    it('bug 3 — a stale menu-item number in the compare table', () => {
      const undo = breakFile('index.html', '<td>Menu items</td><td>60</td>', '<td>Menu items</td><td>25</td>');
      const v = violationsNow();
      undo();
      expect(v).toHaveLength(1);
      expect(v[0].message).toContain('copy states menu_items = 25 on Starter');
      expect(v[0].message).toContain('Starter.limits.menu_items = 60');
    });

    it('bug 3b — a stale ladder in llms.txt', () => {
      const undo = breakFile('llms.txt', '| Growth | ₹299 | ₹2,990 | unlimited | 5 |', '| Growth | ₹299 | ₹2,990 | 25 | 5 |');
      const v = violationsNow();
      undo();
      expect(v).toHaveLength(1);
      expect(v[0].file).toBe('llms.txt');
      expect(v[0].message).toContain('copy caps menu_items at 25 on Growth');
    });

    it('bug 4a — a capability claimed one tier too low', () => {
      const undo = breakFile('llms.txt', '- TDS/TCS and bank reconciliation start on Enterprise.', '- TDS/TCS and bank reconciliation start on Advanced.');
      const v = violationsNow();
      undo();
      expect(v.map((x) => x.message).join('\n')).toContain('attributes "tds_tcs" to Advanced');
    });

    it('bug 4b — a free-forever plan sold as a 7-day trial', () => {
      const undo = breakFile('index.html', '<div class="note">free forever · no card</div>', '<div class="note">7-day free trial · no card</div>');
      const v = violationsNow();
      undo();
      expect(v).toHaveLength(1);
      expect(v[0].message).toContain('card note describes a free-forever plan as a trial');
      expect(v[0].message).toContain('Starter priceInr = 0');
    });

    it('a wrong price anywhere on the site', () => {
      const undo = breakFile('restaurant-billing-software.html', 'Pro is ₹799 a month', 'Pro is ₹899 a month');
      const v = violationsNow();
      undo();
      expect(v).toHaveLength(1);
      expect(v[0].message).toContain('copy states a monthly price of ₹899 for Pro');
      expect(v[0].message).toContain('Pro monthly price = ₹799');
    });

    it('a ladder claim that a cheaper plan already satisfies', () => {
      const undo = breakFile('llms.txt', '- GST tax invoices start on Pro.', '- GST tax invoices start on Advanced.');
      const v = violationsNow();
      undo();
      expect(v).toHaveLength(1);
      expect(v[0].message).toContain('"tax_invoices" starts on Advanced, but cheaper plans already have it');
      expect(v[0].message).toContain('also granted on: Pro');
    });

    it('the un-broken copy in the temp dir is still clean (no leaked edits)', () => {
      expect(violationsNow()).toEqual([]);
    });
  });
});
