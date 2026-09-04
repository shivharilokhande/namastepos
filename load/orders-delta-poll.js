// NamastePOS — k6 load test for the READ path a live restaurant actually hammers.
//
// Two requests, weighted the way real traffic is weighted:
//
//   1. GET /businesses/:id/orders?updatedSince=<watermark>&limit=500
//      The mobile Orders tab polls this every 10 SECONDS per device
//      (namastepos_flutter/lib/screens/orders/orders_screen.dart:45). It is by
//      far the highest-volume authenticated query in the product. Every VU here
//      keeps its own watermark and advances it from the response, exactly like
//      the app does — so the STEADY STATE is an empty delta, which is the case
//      this test is really about (see load/README.md § "expected bottleneck").
//
//   2. GET /businesses/:id/menu
//      Read on POS launch and on pull-to-refresh. Modelled at once every
//      ~2 minutes per device rather than every tick, because that is what it is.
//
// SAFETY: this script REFUSES to run without an explicit TARGET_URL, and
// refuses to touch a production host unless you spell out the override. There is
// no default URL on purpose — a load test that defaults to somewhere is a load
// test that eventually runs against prod by accident.
//
// See load/README.md for the exact command and how to read the result.

import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { Trend, Rate, Counter } from 'k6/metrics';

// ─────────────────────────── configuration ───────────────────────────

const TARGET_URL = __ENV.TARGET_URL || '';
const ALLOW_PROD = __ENV.ALLOW_PROD || '';

// Hosts we will not load-test without an explicit, deliberate override.
const PROD_HOSTS = ['api.namastepos.in', 'namastepos-api.onrender.com'];

// One entry per tenant: { "token": "<owner or staff JWT>", "businessId": "<uuid>" }
// Supply inline as TENANTS='[{...}]' or in a file (default ./tenants.json).
const TENANTS_FILE = __ENV.TENANTS_FILE || './tenants.json';

let TENANTS = [];
if (__ENV.TENANTS) {
  TENANTS = JSON.parse(__ENV.TENANTS);
} else {
  try {
    TENANTS = JSON.parse(open(TENANTS_FILE));
  } catch (e) {
    // Reported in setup() where we can abort with a readable message; throwing
    // at init scope produces a stack trace instead of an explanation.
    TENANTS = [];
  }
}

// 50 concurrent devices across tenants, dinner-rush shaped: a slow fill from
// ~18:30, a sustained peak through the rush, then a drain. Deliberately NOT a
// square wave — the interesting failures (pool exhaustion, plan flips, cache
// stampedes) show up during the ramp, not at the plateau.
export const options = {
  scenarios: {
    dinner_rush: {
      executor: 'ramping-vus',
      startVUs: 5,
      stages: [
        { duration: '2m',  target: 15 }, // early tables
        { duration: '3m',  target: 50 }, // rush builds
        { duration: '10m', target: 50 }, // peak — the number that matters
        { duration: '2m',  target: 10 }, // last covers
        { duration: '1m',  target: 0 },
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    // ── Hard gates. Any breach exits non-zero. ──
    // The delta poll fires every 10s on every device in the building. If p95
    // creeps past half a second the Orders tab feels laggy and, worse, polls
    // start overlapping — each device's requests queue behind its own previous
    // one and offered load silently multiplies.
    'delta_poll_ms': ['p(95)<500', 'p(99)<1500'],
    // Menu is a bigger payload but is read rarely; it may be slower.
    'menu_read_ms': ['p(95)<800', 'p(99)<2000'],
    // Whole-test error budget. 1% of a 10s poll is a device showing stale
    // orders for ~17 minutes a day — already too much.
    'http_req_failed': ['rate<0.01'],
    'errors': ['rate<0.01'],
    'checks': ['rate>0.99'],
  },
  // Keep the summary readable and comparable run to run.
  summaryTrendStats: ['avg', 'min', 'med', 'p(95)', 'p(99)', 'max'],
};

// ─────────────────────────── metrics ───────────────────────────

const deltaPoll   = new Trend('delta_poll_ms', true);
const menuRead    = new Trend('menu_read_ms', true);
const errors      = new Rate('errors');
// How often a poll actually had something to report. In a real service this is
// LOW (a few percent) — which is the whole point of the delta poll. If the
// empty-delta case is slow, you are paying full price for nothing.
const emptyDeltas = new Counter('delta_empty');
const rowDeltas   = new Counter('delta_with_rows');

// ─────────────────────────── guards ───────────────────────────

export function setup() {
  if (!TARGET_URL) {
    exec.test.abort(
      'TARGET_URL is required. Point it at a DEPLOYED environment including the '
      + '/v1 prefix, e.g. TARGET_URL=https://staging-api.example.com/v1. '
      + 'There is no default on purpose.',
    );
  }

  let host = '';
  try {
    host = new URL(TARGET_URL).host;
  } catch (e) {
    exec.test.abort(`TARGET_URL is not a valid absolute URL: "${TARGET_URL}"`);
  }

  const isProd = PROD_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  if (isProd && ALLOW_PROD !== 'yes-i-mean-it') {
    exec.test.abort(
      `Refusing to load-test the production host "${host}". This drives ~50 `
      + 'concurrent devices at a live restaurant API. Run it against staging. '
      + 'If you genuinely intend to test prod, re-run with '
      + 'ALLOW_PROD=yes-i-mean-it and do it outside 11:00-15:00 and 18:00-23:00 IST.',
    );
  }

  if (!TENANTS.length) {
    exec.test.abort(
      `No tenants configured. Provide TENANTS='[{"token":"...","businessId":"..."}]' `
      + `or a JSON array at ${TENANTS_FILE}. See load/README.md for how to mint them.`,
    );
  }

  for (const t of TENANTS) {
    if (!t.token || !t.businessId) {
      exec.test.abort('Every tenant entry needs both "token" and "businessId".');
    }
  }

  // Fail fast on a bad token/URL rather than burning 18 minutes producing 401s.
  const probe = http.get(`${TARGET_URL}/businesses/${TENANTS[0].businessId}/menu`, {
    headers: { Authorization: `Bearer ${TENANTS[0].token}` },
  });
  if (probe.status !== 200) {
    exec.test.abort(
      `Pre-flight failed: GET /businesses/:id/menu returned ${probe.status}. `
      + 'Check TARGET_URL (does it include /v1?) and that the token is unexpired.',
    );
  }

  return { host, tenantCount: TENANTS.length, startedAt: new Date().toISOString() };
}

// ─────────────────────────── the device loop ───────────────────────────

const POLL_INTERVAL_S = 10;      // matches orders_screen.dart
const MENU_EVERY_N_POLLS = 12;   // ≈ every 2 minutes

/** Per-VU (= per-device) delta watermark + poll counter. See default() below. */
let vuState = null;

export default function () {
  // Spread devices across tenants so the load is multi-tenant, not one hot row.
  const tenant = TENANTS[exec.vu.idInTest % TENANTS.length];
  const params = {
    headers: {
      Authorization: `Bearer ${tenant.token}`,
      'Content-Type': 'application/json',
    },
    // Tag so per-endpoint metrics stay separable in the summary and in any
    // downstream output (k6 cloud / Prometheus).
    tags: { tenant: tenant.businessId },
  };

  // Each VU keeps its own watermark, like a real device. k6 gives every VU its
  // own JS runtime, so this module-scope object IS per-device state — no keying
  // by VU id needed. Initialised to "now" on the first iteration so we
  // exercise the steady-state empty delta rather than a cold backfill.
  if (!vuState) {
    vuState = { since: new Date().toISOString(), polls: 0 };
  }

  const started = Date.now();

  // ── 1. the 10s delta poll ────────────────────────────────────────────────
  const deltaUrl = `${TARGET_URL}/businesses/${tenant.businessId}/orders`
    + `?updatedSince=${encodeURIComponent(vuState.since)}&limit=500`;
  const deltaRes = http.get(deltaUrl, { ...params, tags: { ...params.tags, ep: 'orders_delta' } });

  deltaPoll.add(deltaRes.timings.duration);
  const deltaOk = check(deltaRes, {
    'delta poll 200': (r) => r.status === 200,
    'delta poll is json': (r) => String(r.headers['Content-Type'] || '').includes('application/json'),
  });
  errors.add(!deltaOk);

  if (deltaOk) {
    let rows = [];
    try {
      const body = deltaRes.json();
      rows = Array.isArray(body) ? body : (body.orders || body.data || []);
    } catch (e) {
      rows = [];
    }
    if (rows.length) {
      rowDeltas.add(1);
      // Advance the watermark exactly like the client: to the newest
      // updated_at we just saw. Anything else either re-reads rows forever or
      // silently skips updates.
      const newest = rows
        .map((o) => o.updatedAt || o.updated_at)
        .filter(Boolean)
        .sort()
        .pop();
      if (newest) vuState.since = newest;
    } else {
      emptyDeltas.add(1);
    }
  }

  vuState.polls += 1;

  // ── 2. the POS menu read ─────────────────────────────────────────────────
  if (vuState.polls % MENU_EVERY_N_POLLS === 0) {
    const menuRes = http.get(
      `${TARGET_URL}/businesses/${tenant.businessId}/menu`,
      { ...params, tags: { ...params.tags, ep: 'menu' } },
    );
    menuRead.add(menuRes.timings.duration);
    const menuOk = check(menuRes, {
      'menu read 200': (r) => r.status === 200,
      'menu read non-empty': (r) => {
        try {
          const b = r.json();
          const items = Array.isArray(b) ? b : (b.items || b.data || []);
          return items.length > 0;
        } catch (e) { return false; }
      },
    });
    errors.add(!menuOk);
  }

  // Hold the real 10s cadence regardless of how slow the responses were — a
  // device's timer does not wait for the previous request. If the API is slow
  // enough that an iteration overruns the interval, sleep(0) makes the
  // overlap visible in the arrival rate instead of hiding it.
  const elapsedS = (Date.now() - started) / 1000;
  sleep(Math.max(0, POLL_INTERVAL_S - elapsedS));
}

export function teardown(data) {
  // eslint-disable-next-line no-console
  console.log(
    `\nRan against ${data.host} with ${data.tenantCount} tenant(s), started ${data.startedAt}.`
    + '\nCheck delta_empty vs delta_with_rows in the summary: if delta_empty dominates'
    + '\n(it should) then delta_poll_ms is the cost of returning NOTHING.\n',
  );
}
