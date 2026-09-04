// NamastePOS CI E2E — seeding helpers.
//
// WHY THIS SEEDS OVER HTTP INSTEAD OF IMPORTING tests/setup.js
// ------------------------------------------------------------
// The backend's Jest helpers (namastepos_backend/tests/setup.js) export exactly
// the shapes we want — `resetDb`, `makeBusiness`, `tokenFor` — but that module
// calls `jest.mock('../src/services/googleService', …)` at MODULE SCOPE. Outside
// a Jest runtime `jest` is undefined, so `require()`-ing it from a Playwright
// process throws before a single row is written. It cannot be reused as-is.
//
// So we keep the same SHAPES (`makeBusiness` returning a business that carries
// its owner, `tokenFor(business)` returning that owner's bearer token) but seed
// through the real REST API instead of raw SQL. That is strictly better here:
//   • zero hand-written SQL, so this file cannot drift from the schema the way
//     a duplicated INSERT would (setup.js already carries three try/catch
//     fallbacks for exactly that drift);
//   • it exercises the production registration + menu + staff code paths, so a
//     break in them fails the seed loudly instead of being papered over;
//   • it works against ANY reachable backend (CI service, local dev, a review
//     app) with no DB credentials.
//
// Migrations are applied by the CI job before this runs (`npm run migrate`);
// this module never resets the schema.

import { APIRequestContext, request, expect } from '@playwright/test';

/** Backend origin INCLUDING the /v1 prefix. */
export const API_URL = process.env.E2E_API_URL || 'http://localhost:4000/v1';

/** Every seeded owner shares this password — it only ever exists in CI. */
export const OWNER_PASSWORD = 'e2e-Password-123';

export type SeededBusiness = {
  businessId: string;
  businessName: string;
  ownerEmail: string;
  ownerPassword: string;
  /** Owner access token. Mirrors `tokenFor(business)` in the Jest helpers. */
  token: string;
  /** Pre-authenticated request context bound to the owner. */
  api: APIRequestContext;
};

export type SeededMenuItem = {
  id: string;
  name: string;
  /** Rupees. */
  price: number;
  gstPct: number;
};

export type SeededStaff = {
  userId: string;
  displayName: string;
  role: string;
  phone: string;
  pin: string;
};

/** Collision-proof suffix so specs never share a tenant, user or phone. */
function uniq(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * A 10-digit Indian-format mobile that is unique per call. `/auth/staff-resolve`
 * matches on phone, so two specs reusing one number would resolve each other's
 * outlets — hence the derived-from-uniq() digits rather than a constant.
 */
function uniquePhone(): string {
  const d = String(Date.now()).slice(-8);
  const r = String(Math.floor(Math.random() * 90) + 10);
  return `9${d}${r}`.slice(0, 10);
}

async function assertOk(res: { ok(): boolean; status(): number; text(): Promise<string> }, what: string) {
  if (!res.ok()) {
    throw new Error(`[seed] ${what} failed with HTTP ${res.status()}: ${await res.text()}`);
  }
}

/**
 * Register a brand-new tenant and return its owner session.
 *
 * Mirrors `makeBusiness()` from the backend Jest helpers: one call gives you a
 * business whose owner can immediately authenticate. `/auth/register` creates
 * the user, the business, the business_users owner membership AND the trialing
 * free subscription in one server-side transaction — the same path a real
 * signup takes.
 */
export async function makeBusiness(opts: { name?: string } = {}): Promise<SeededBusiness> {
  const id = uniq();
  const ownerEmail = `e2e-owner-${id}@example.com`;
  const businessName = opts.name || `E2E Cafe ${id}`;

  const api = await request.newContext({ baseURL: API_URL });
  const res = await api.post('/auth/register', {
    data: {
      email: ownerEmail,
      password: OWNER_PASSWORD,
      name: 'E2E Owner',
      businessName,
    },
  });
  await assertOk(res, `register ${ownerEmail}`);
  const body = await res.json();

  const businessId: string = body?.business?.id;
  const token: string = body?.token;
  expect(businessId, '[seed] register returned no business id').toBeTruthy();
  expect(token, '[seed] register returned no access token').toBeTruthy();

  // Bind the bearer for every later seed call on this context.
  await api.dispose();
  const authed = await request.newContext({
    baseURL: API_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });

  return {
    businessId,
    businessName,
    ownerEmail,
    ownerPassword: OWNER_PASSWORD,
    token,
    api: authed,
  };
}

/** Mirrors `tokenFor(business)` in the Jest helpers. */
export function tokenFor(business: SeededBusiness): string {
  return business.token;
}

/**
 * Skip the first-run onboarding wizard.
 *
 * `createBusinessForUser` inserts `onboarded = FALSE`, and Layout.tsx redirects
 * to /onboarding on cold start when it sees that flag with no menu/tables. It
 * *would* self-heal (it patches the flag once it finds a menu item), but that
 * heal is an async patch + query invalidation racing our first assertion. Doing
 * it here makes every spec's first paint deterministic.
 */
export async function markOnboarded(b: SeededBusiness): Promise<void> {
  const res = await b.api.patch('/auth/me', { data: { onboarded: true } });
  await assertOk(res, 'PATCH /auth/me { onboarded: true }');
}

/**
 * Create one menu item.
 *
 * Defaults to `gstPct: 0` deliberately. The money assertions in
 * money-flow.spec.ts must pin an EXACT rupee total, and a non-zero GST rate
 * drags in per-business round-off, service-charge and discount-is-pre-tax
 * settings — real behaviour, but it would make the expected number a function
 * of tenant config instead of a constant. Zero-rated keeps `total = price × qty`
 * exact, so any regression in the pricing pipeline is unambiguous.
 */
export async function addMenuItem(
  b: SeededBusiness,
  opts: { name?: string; price?: number; gstPct?: number; category?: string } = {},
): Promise<SeededMenuItem> {
  const name = opts.name || `E2E Thali ${uniq()}`;
  const price = opts.price ?? 100;
  const gstPct = opts.gstPct ?? 0;
  const res = await b.api.post(`/businesses/${b.businessId}/menu`, {
    data: {
      name,
      price,
      gstPct,
      category: opts.category || 'Food',
      isActive: true,
      // trackStock false so an order can never fail on an out-of-stock guard.
      trackStock: false,
      stock: 0,
    },
  });
  await assertOk(res, `create menu item "${name}"`);
  const item = await res.json();
  const itemId = item?.id || item?.item?.id;
  expect(itemId, '[seed] menu create returned no id').toBeTruthy();
  return { id: itemId, name, price, gstPct };
}

/**
 * Add a PIN staff member. `role` accepts any of the backend's staff roles;
 * `staff_kitchen` (perms: home + kds only) is what staff-rbac.spec.ts uses.
 */
export async function addPinStaff(
  b: SeededBusiness,
  opts: { role: string; displayName?: string; pin?: string },
): Promise<SeededStaff> {
  const displayName = opts.displayName || `E2E ${opts.role}`;
  const pin = opts.pin || '4321';
  const phone = uniquePhone();
  const res = await b.api.post(`/businesses/${b.businessId}/staff/pin`, {
    data: { displayName, role: opts.role, pin, phone },
  });
  await assertOk(res, `create ${opts.role} staff`);
  const created = await res.json();
  const userId = created?.userId || created?.id || created?.staff?.userId;
  expect(userId, '[seed] staff create returned no userId').toBeTruthy();
  return { userId, displayName, role: opts.role, phone, pin };
}

/**
 * Sign a PIN staff member in over the API and return a request context bound to
 * their token. Uses the same two-step the login screen uses: resolve the phone
 * to its outlet(s), then exchange the PIN for a session.
 */
export async function pinLoginContext(staff: SeededStaff): Promise<APIRequestContext> {
  const anon = await request.newContext({ baseURL: API_URL });

  const resolved = await anon.post('/auth/staff-resolve', { data: { phone: staff.phone } });
  await assertOk(resolved, `staff-resolve ${staff.phone}`);
  const outlets = (await resolved.json())?.outlets || [];
  expect(outlets.length, `[seed] staff-resolve returned no outlet for ${staff.phone}`).toBeGreaterThan(0);

  const res = await anon.post('/auth/pin-login', {
    data: {
      businessId: outlets[0].businessId,
      userId: outlets[0].userId,
      pin: staff.pin,
    },
  });
  await assertOk(res, `pin-login for ${staff.displayName}`);
  const token = (await res.json())?.token;
  expect(token, '[seed] pin-login returned no token').toBeTruthy();
  await anon.dispose();

  return request.newContext({
    baseURL: API_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

/** Read one order back from the API — the authoritative money figure. */
export async function getOrder(b: SeededBusiness, orderId: string): Promise<any> {
  const res = await b.api.get(`/businesses/${b.businessId}/orders/${orderId}`);
  await assertOk(res, `GET order ${orderId}`);
  return res.json();
}

/** Today's date in the IST business day, as the dashboard computes it. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The tenant's daily report — `revenue.total` is what Overview renders. */
export async function dailyReport(b: SeededBusiness, date = todayIso()): Promise<any> {
  const res = await b.api.get(`/businesses/${b.businessId}/reports/daily`, {
    params: { date },
  });
  await assertOk(res, `GET /reports/daily?date=${date}`);
  return res.json();
}
