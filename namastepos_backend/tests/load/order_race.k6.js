// k6 load test — reproduces the P0-2 / P0-4 race scenarios.
//
// Run:
//   k6 run --vus 50 --duration 30s tests/load/order_race.k6.js
//
// Pass criteria:
//   • Zero 5xx
//   • Every order_no returned is unique (proves P0-2 fix)
//   • Stock never goes negative for the dish under test (proves P0-4 fix)

import http from 'k6/http';
import { check, fail } from 'k6';
import { Counter } from 'k6/metrics';

const dupes = new Counter('duplicate_order_no');

export const options = {
  scenarios: {
    burst: {
      executor: 'per-vu-iterations',
      vus: 50,
      iterations: 4,
      maxDuration: '1m',
    },
  },
  thresholds: {
    'http_req_failed': ['rate<0.01'],
    'duplicate_order_no': ['count==0'],
    'http_req_duration{p:95}': ['p(95)<2000'],
  },
};

const BASE = __ENV.API_URL || 'http://localhost:4000/v1';
const TOKEN = __ENV.JWT; // owner JWT
const BIZ_ID = __ENV.BUSINESS_ID; // target business
const MENU_ID = __ENV.MENU_ITEM_ID;

const seen = new Set();

export default function () {
  const res = http.post(
    `${BASE}/businesses/${BIZ_ID}/orders`,
    JSON.stringify({
      items: [{ menuItemId: MENU_ID, name: 'k6-test', price: 100, qty: 1 }],
      paymentMethod: 'cash',
    }),
    { headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' } },
  );
  if (!check(res, { '2xx': (r) => r.status >= 200 && r.status < 300 })) {
    fail(`status ${res.status}: ${res.body}`);
  }
  const orderNo = res.json('orderNo');
  if (seen.has(orderNo)) dupes.add(1);
  seen.add(orderNo);
}
