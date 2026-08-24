// NamastePOS — Mixed-workload load test (k6).
//
// Simulates a realistic day-in-the-life of a busy cafe on NamastePOS:
//
//   Every virtual user (VU) is one cafe. Each VU cycles through:
//     - /health           (5% of requests — LB probes)
//     - /auth/me          (30% — session refresh + drawer opens)
//     - /addons           (10% — sidebar re-render)
//     - /menu             (15% — POS launches)
//     - /orders?pending   (25% — Live orders polling)
//     - /reports/daily    (10% — Overview refresh)
//     - /ops/tables       (5% — Captain refresh)
//
// This mix mirrors what your production Nginx logs will look like
// once real cafes are placing orders. Adjust `stages` for your target.
//
// Run:
//   brew install k6                  (macOS)
//   API_BASE=http://localhost:4000 API_TOKEN=<bearer> \
//   BIZ_ID=<uuid> k6 run k6-mixed-workload.js
//
// To get a token + biz id, log in via the mobile app or dashboard and
// grab them from localStorage / the browser network tab.

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const API_BASE = __ENV.API_BASE || 'http://localhost:4000/v1';
const TOKEN    = __ENV.API_TOKEN || '';
const BIZ_ID   = __ENV.BIZ_ID    || '';

const errorRate = new Rate('errors');
const readTime  = new Trend('read_time_ms', true);

// ────────── LOAD PROFILE ──────────
// Ramps up to 100 concurrent virtual users over 30s, holds for 3 min,
// then ramps down. This maps to ~300-600 RPS depending on how fast
// your API responds. Adjust the middle stage for a bigger test.
export const options = {
  stages: [
    { duration: '30s', target: 20 },   // warm-up
    { duration: '30s', target: 100 },  // ramp
    { duration: '3m',  target: 100 },  // sustained load
    { duration: '30s', target: 0 },    // cool-down
  ],
  thresholds: {
    // p95 latency must stay under 800ms; p99 under 2s. If either
    // breaches the test exits with non-zero — good for CI gates.
    http_req_duration: ['p(95)<800', 'p(99)<2000'],
    errors:            ['rate<0.01'], // <1% error rate
    checks:            ['rate>0.99'], // 99% of assertions pass
  },
};

const headers = () => ({
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
  },
});

function biz(path) { return `${API_BASE}/businesses/${BIZ_ID}${path}`; }
function raw(path) { return `${API_BASE}${path}`; }

// Weighted random choice — same shape as the day-in-the-life mix above.
const scenarios = [
  { weight: 5,  name: 'health',       url: () => raw('/health') },
  { weight: 30, name: 'me',           url: () => raw('/auth/me') },
  { weight: 10, name: 'addons',       url: () => biz('/addons') },
  { weight: 15, name: 'menu',         url: () => biz('/menu') },
  { weight: 25, name: 'ordersPending',url: () => biz('/orders?status=pending&groupBy=session') },
  { weight: 10, name: 'reportsDaily', url: () => biz(`/reports/daily?date=${new Date().toISOString().slice(0,10)}`) },
  { weight: 5,  name: 'opsTables',    url: () => biz('/ops/tables') },
];
const totalWeight = scenarios.reduce((s, x) => s + x.weight, 0);
function pick() {
  let r = Math.random() * totalWeight;
  for (const s of scenarios) { r -= s.weight; if (r <= 0) return s; }
  return scenarios[0];
}

export default function () {
  if (!TOKEN || !BIZ_ID) {
    throw new Error('Set API_TOKEN and BIZ_ID env vars. See k6-mixed-workload.js header.');
  }
  const s = pick();
  group(s.name, () => {
    const t0 = Date.now();
    const url = s.url();
    // /health is unauthenticated
    const opts = s.name === 'health' ? {} : headers();
    const res = http.get(url, opts);
    readTime.add(Date.now() - t0);
    const ok = check(res, {
      'status is 2xx': (r) => r.status >= 200 && r.status < 300,
    });
    errorRate.add(!ok);
    if (!ok) {
      console.error(`[${s.name}] ${res.status} ${url}`);
    }
  });
  // A tiny bit of think-time so we don't hammer with zero latency
  // between requests — mirrors a human tapping the UI.
  sleep(Math.random() * 0.6 + 0.2);
}

// Summary printed at end of run.
export function handleSummary(data) {
  const p = data.metrics.http_req_duration.values;
  const errs = data.metrics.errors ? data.metrics.errors.values.rate : 0;
  const rps = data.metrics.http_reqs.values.rate;
  const total = data.metrics.http_reqs.values.count;
  const lines = [
    '',
    '════════════ NamastePOS load test — summary ════════════',
    `Total requests:      ${total}`,
    `Sustained RPS:       ${rps.toFixed(1)}`,
    `p50 latency:         ${p['p(50)'].toFixed(0)} ms`,
    `p95 latency:         ${p['p(95)'].toFixed(0)} ms`,
    `p99 latency:         ${p['p(99)'].toFixed(0)} ms`,
    `Max latency:         ${p.max.toFixed(0)} ms`,
    `Error rate:          ${(errs * 100).toFixed(2)}%`,
    '',
    'Interpretation:',
    '  ≥300 RPS + p95<800ms = healthy for launch',
    '  100-300 RPS         = tune DB pool + PM2 workers',
    '  <100 RPS            = something is very wrong — do NOT deploy',
    '══════════════════════════════════════════════════════',
    '',
  ];
  return { stdout: lines.join('\n') };
}
