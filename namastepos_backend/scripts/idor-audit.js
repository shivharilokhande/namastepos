#!/usr/bin/env node
/*
 * NamastePOS — IDOR audit script (FF-212).
 *
 * Purpose:
 *   For every business-scoped GET route, prove that Owner A's JWT
 *   cannot read Owner B's data. A pass here = the requireBusinessOwnership
 *   middleware fires on every route, and none of the newer routes forgot
 *   to attach it.
 *
 * How to run:
 *   1. Start the API (npm run dev)
 *   2. node scripts/idor-audit.js
 *
 * It expects two pre-seeded owners in the DB (default seed does this):
 *   OWNER_A_EMAIL=owner-a@example.com  (business 1)
 *   OWNER_B_EMAIL=demo2@namastepos.in           (business 2)
 * Override via env vars.
 *
 * The script:
 *   1. Dev-logs in as A → gets access token + businessId_A
 *   2. Dev-logs in as B → gets access token + businessId_B
 *   3. For each route in ROUTES, hits GET /v1/businesses/{businessId_B}/...
 *      using Owner A's Bearer token. Expects 403 FORBIDDEN.
 *   4. Any non-403 (200/401/404/500) fails the audit.
 *
 * Exit code 0 → all routes correctly refused cross-tenant access.
 * Exit code 1 → at least one route leaked. Full report printed.
 */

const http = require('http');
const url = require('url');

const BASE = process.env.API_BASE || 'http://localhost:4000/v1';
// Hardcode-audit fix (2026-08-24): no personal-account defaults — the two
// tenant owner emails must be supplied explicitly.
const OWNER_A_EMAIL = process.env.OWNER_A_EMAIL;
const OWNER_B_EMAIL = process.env.OWNER_B_EMAIL;
if (!OWNER_A_EMAIL || !OWNER_B_EMAIL) {
  console.error('Set OWNER_A_EMAIL and OWNER_B_EMAIL (two distinct dev-login tenants) to run the IDOR audit.');
  process.exit(1);
}

// GET routes that must be tenant-isolated. Add new ones as the API grows.
// {segment} is a placeholder — we substitute with businessId_B before hitting.
const ROUTES = [
  '/orders',
  '/orders/pending',
  '/orders?groupBy=session',
  '/menu/items',
  '/menu/categories',
  '/menu/modifier-groups',
  '/staff',
  '/expenses',
  '/customers',
  '/reports/pnl',
  '/reports/kpis',
  '/reports/revenue-daily',
  '/tax-invoices',
  '/billing/subscription',
  '/addons',
  '/ops/tables',
  '/ops/floors',
  '/ops/kot/tickets',
  '/ops/kot/stations',
  '/ops/reservations',
  '/ops/reviews',
  '/ops/daily-closing',
  '/ops/wastage',
  '/ingredients',
  '/print-jobs/next',
];

function request(method, endpoint, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = url.parse(endpoint.startsWith('http') ? endpoint : BASE + endpoint);
    const req = http.request({
      method,
      hostname: u.hostname,
      port: u.port || 80,
      path: u.path,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch (_) { /* ignore */ }
        resolve({ status: res.statusCode, body: json, raw: data });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function devLogin(email) {
  const r = await request('POST', '/auth/dev-login', { body: { email } });
  if (r.status !== 200) {
    throw new Error(`dev-login for ${email} failed: HTTP ${r.status} — ${r.raw}`);
  }
  // /me tells us which business the account owns.
  const me = await request('GET', '/auth/me', { token: r.body.token });
  return {
    token: r.body.token,
    businessId: me.body?.business?.id || me.body?.businessId || null,
    email,
  };
}

(async () => {
  console.log(`[idor-audit] BASE=${BASE}`);
  console.log(`[idor-audit] Owner A: ${OWNER_A_EMAIL}`);
  console.log(`[idor-audit] Owner B: ${OWNER_B_EMAIL}`);
  let a, b;
  try {
    a = await devLogin(OWNER_A_EMAIL);
    b = await devLogin(OWNER_B_EMAIL);
  } catch (e) {
    console.error(`[idor-audit] FATAL — could not log in seed owners: ${e.message}`);
    console.error('Hint: ensure both accounts exist and NODE_ENV allows dev-login.');
    process.exit(2);
  }
  if (!a.businessId || !b.businessId) {
    console.error('[idor-audit] FATAL — one of the owners has no business attached.');
    console.error(JSON.stringify({ a, b }, null, 2));
    process.exit(2);
  }
  if (a.businessId === b.businessId) {
    console.error('[idor-audit] FATAL — A and B share the same businessId. Seed two.');
    process.exit(2);
  }

  const results = [];
  for (const path of ROUTES) {
    const endpoint = `/businesses/${b.businessId}${path}`;
    const r = await request('GET', endpoint, { token: a.token });
    const pass = r.status === 403;
    results.push({ endpoint, status: r.status, pass });
    console.log(`${pass ? '✓' : '✗'} HTTP ${r.status}  ${endpoint}`);
  }
  const failed = results.filter((r) => !r.pass);
  console.log('\n─── SUMMARY ─────────────────────────────');
  console.log(`Total routes tested:  ${results.length}`);
  console.log(`Refused (403) — safe: ${results.length - failed.length}`);
  console.log(`Leaked or wrong code: ${failed.length}`);
  if (failed.length) {
    console.log('\n⚠  FAILURES:');
    for (const f of failed) {
      console.log(`   HTTP ${f.status}  ${f.endpoint}`);
    }
    process.exit(1);
  }
  console.log('\n✓ Every business-scoped GET refused cross-tenant access.');
})().catch((e) => {
  console.error('[idor-audit] uncaught', e);
  process.exit(2);
});
