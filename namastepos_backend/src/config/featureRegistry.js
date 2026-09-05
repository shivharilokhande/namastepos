// NamastePOS — THE FEATURE REGISTRY.
//
// ══════════════════════════════════════════════════════════════════════════
// ONE list of every plan feature key the product knows about. Read this
// before adding a feature key ANYWHERE.
// ══════════════════════════════════════════════════════════════════════════
//
// The founder's requirement, verbatim:
//   "every features should be in admin to add it in plans, and each plan
//    should be properly synced and working according to that only in
//    dashboard and mobile app both."
//
// That requires three sets to be identical, and until this file existed they
// were three separate hand-maintained lists that drifted every time somebody
// shipped a feature:
//
//   (a) what the BACKEND enforces   — middleware/featureGate.js FEATURE_RULES,
//                                     requireFeature(), hasFeature()
//   (b) what ADMIN can grant        — services/featureService.js used to carry
//                                     its own WELL_KNOWN_FEATURE_KEYS array;
//                                     the console's picker reads whatever
//                                     GET /admin/feature-catalog returns
//   (c) what the DATA says          — plan_features rows / the live plan feed
//
// Three separate repairs are recorded in git for exactly this rot:
//   * FF-402 "restore-orphans" — inventory_tracking, memberships, reviews and
//     marketplace_addons were enforced on live routes but missing from the
//     catalog, so the founder could not switch them on at all.
//   * 2026-09-03 plans/addons audit — paid add-ons unlocked nothing because
//     the addon slug was not the feature key, and per-business overrides were
//     dead code.
//   * dashboard_access — granted by migration 034, "checked by app code"
//     according to the comment, absent from the catalog until someone noticed.
//
// Each was fixed by hand. The fourth was going to land the same way, because
// nothing compared the lists. This file is the comparison's fixed point:
// scripts/feature-registry-audit.js derives (a) and (c) from the source and
// the data and fails when either disagrees with what is declared here, and
// tests/integration/featureRegistryDrift.test.js makes that a blocking gate.
// Same shape as scripts/marketing-claims.js does for marketing copy.
//
// ── ADDING A FEATURE KEY ────────────────────────────────────────────────
//   1. Add an entry below (key, label, group, enforcement).
//   2. Add the actual gate — a FEATURE_RULES row, a requireFeature() call, or
//      a client-side check.
//   3. That is all. The admin catalog, the plan feature picker, the custom
//      plan builder, the add-on "grants features" picker and the per-business
//      override dropdown all read this registry through
//      GET /v1/admin/feature-catalog. Nothing else needs editing and no
//      second list exists to forget.
//
// ── enforcement VALUES ──────────────────────────────────────────────────
//   'route'      a path rule in middleware/featureGate.js FEATURE_RULES.
//   'middleware' an explicit requireFeature(key) on a route file.
//   'service'    a hasFeature(businessId, key) branch inside a service.
//   'client'     NO server surface to gate — the capability lives entirely in
//                a client (a mic button, a drawer tile, a nav item). The
//                server still ships the key in /auth/me `plan.features`; the
//                client is what must honour it. `clients` names which ones.
//   'ungated'    granted by plans and enforced NOWHERE. Every one of these is
//                a known gap and MUST carry `why`. The audit keeps the set
//                frozen, so a key cannot quietly slide in or out of it.
//
// `enforcement: 'client'` is not a lesser gate — it is where the founder's bug
// lived. A key nothing enforces at all is a promise the product does not keep.

/**
 * Display groups, in the order the admin picker renders them. A group is
 * cosmetic; the audit does not care about it, but the console does — this is
 * why the console no longer keeps its own bucket map.
 */
const GROUPS = Object.freeze([
  'Core',
  'Menu',
  'Tables',
  'Kitchen & ops',
  'Delivery',
  'Customers & marketing',
  'Reports',
  'Billing & accounting',
  'Advanced',
]);

/**
 * THE REGISTRY. Ordered by group then key so the console renders predictably.
 * `key` is what plan_features stores and what /auth/me ships to clients.
 */
const FEATURES = Object.freeze([
  // ── Core ───────────────────────────────────────────────────────────────
  {
    key: 'pos',
    label: 'POS / billing screen',
    group: 'Core',
    enforcement: 'ungated',
    why: 'The product itself. Every plan grants it and no gate exists or should — '
      + 'a tenant with no POS screen has bought nothing. Kept in the catalog so '
      + 'the plan cards can list it.',
  },
  {
    key: 'orders',
    label: 'Orders',
    group: 'Core',
    enforcement: 'client',
    clients: ['dashboard'],
  },
  {
    key: 'token_generation',
    label: 'Token / queue numbers',
    group: 'Core',
    enforcement: 'ungated',
    why: 'Token numbers are printed by the ordinary bill path; there is no separate '
      + 'endpoint or screen to gate. Advertised on Starter, so gating it would be a '
      + 'downgrade, not a fix.',
  },
  {
    key: 'expenses',
    label: 'Expense book',
    group: 'Core',
    enforcement: 'client',
    clients: ['dashboard'],
  },
  {
    key: 'staff_lite',
    label: 'Staff accounts',
    group: 'Core',
    enforcement: 'client',
    clients: ['dashboard'],
  },
  {
    key: 'staff_unlimited',
    label: 'Unlimited staff accounts',
    group: 'Core',
    enforcement: 'ungated',
    why: 'A CLAIM, not a gate. The staff cap is enforced solely from plans.limits.staff '
      + 'by subscriptionService.enforceLimit. Grant it only where limits.staff = -1 — '
      + 'migration 090 removed it from Pro (Rs 799), which caps staff at 10, and '
      + 'tests/integration/proStaffClaim2026.test.js keeps the two in step.',
  },
  {
    key: 'dashboard_access',
    label: 'Web dashboard access',
    group: 'Core',
    enforcement: 'ungated',
    why: 'Migration 034 introduced this to make the web dashboard a paid step up from '
      + 'mobile-only, and the migration comment claims "app code checks for it". '
      + 'Nothing does — not the backend, not the dashboard. Every tenant can open '
      + 'app.namastepos.in today. Closing it is a deliberate commercial change that '
      + 'would lock out live Starter tenants, so it is recorded here rather than '
      + 'silently switched on.',
  },
  {
    key: 'custom_branding',
    label: 'Custom bill branding',
    group: 'Core',
    enforcement: 'middleware',
    note: "requireFeature('custom_branding') on the bill-template write route "
      + '(routes/sprint1Extras.routes.js).',
  },

  // ── Menu ───────────────────────────────────────────────────────────────
  {
    key: 'menu_basic',
    label: 'Menu management',
    group: 'Menu',
    enforcement: 'client',
    clients: ['dashboard'],
  },
  {
    key: 'menu_variants_modifiers',
    label: 'Variants & modifiers',
    group: 'Menu',
    enforcement: 'route',
  },
  {
    key: 'inventory_tracking',
    label: 'Inventory tracking',
    group: 'Menu',
    enforcement: 'client',
    clients: ['mobile', 'dashboard'],
    note: 'FF-402 restored this to the catalog. The mobile drawer tile is gated; the '
      + 'stock endpoints themselves are not, because Starter needs stock counts for '
      + 'the items it does sell. 2026-09-06 (review D-13): the web dashboard now gates '
      + 'its /inventory page on this key too — it used to unlock on menu_basic, so web '
      + 'and mobile disagreed about which plan includes Inventory.',
  },
  {
    key: 'recipe_costing',
    label: 'Recipe costing',
    group: 'Menu',
    enforcement: 'route',
  },
  {
    key: 'wastage',
    label: 'Wastage log',
    group: 'Menu',
    enforcement: 'route',
  },
  {
    key: 'dead_stock',
    label: 'Dead-stock report',
    group: 'Menu',
    enforcement: 'route',
  },
  {
    key: 'bulk_import',
    label: 'Bulk menu import',
    group: 'Menu',
    enforcement: 'route',
  },

  // ── Tables ─────────────────────────────────────────────────────────────
  {
    key: 'tables_single_floor',
    label: 'Tables (single floor)',
    group: 'Tables',
    enforcement: 'client',
    clients: ['dashboard'],
  },
  {
    key: 'tables_multi_floor',
    label: 'Multiple floors',
    group: 'Tables',
    enforcement: 'ungated',
    why: 'A CLAIM. The real cap is plans.limits.floors (migration 038) enforced by '
      + "subscriptionService.enforceLimit('floors'). The featureGate rule that once "
      + 'used this key was removed in Push 13.7 because it 402d Starter tenants '
      + 'loading a running bill. Grant it where limits.floors > 1.',
  },
  {
    key: 'reservations',
    label: 'Reservations & wait-list',
    group: 'Tables',
    enforcement: 'route',
  },
  {
    key: 'bill_split',
    label: 'Split bill / split payment',
    group: 'Tables',
    enforcement: 'route',
  },

  // ── Kitchen & ops ──────────────────────────────────────────────────────
  {
    key: 'kds',
    label: 'Kitchen display (KDS/KOT)',
    group: 'Kitchen & ops',
    enforcement: 'route',
  },
  {
    key: 'captain_mode',
    label: 'Captain ordering',
    group: 'Kitchen & ops',
    enforcement: 'client',
    clients: ['dashboard', 'mobile'],
    note: '2026-09-05 (entitlements review B6): was declared route-enforced by a '
      + "featureGate rule on '/captain/' — a path NO route has ever had (the captain "
      + 'screens call the ordinary /ops/tables and /sessions APIs, which Starter needs '
      + 'too). The dead rule is gone; the real gates are the dashboard nav entry '
      + '(components/Layout.tsx) and the mobile drawer tile + Tables tab '
      + '(lib/constants/feature_keys.dart). There is no server surface to gate.',
  },
  {
    key: 'voice_pos',
    label: 'Voice POS (speak an order)',
    group: 'Kitchen & ops',
    enforcement: 'client',
    // 2026-09-05 (dashboard review D-06): the web POS also has a mic
    // (components/NewOrderDialog.tsx) and it was ungated on every plan — the
    // same bug on a second client. It now checks plan.has('voice_pos'); the
    // drift audit scans namastepos_dashboard/src for that call.
    clients: ['mobile', 'dashboard'],
    note: 'THE 2026-09-05 BUG. Granted on Enterprise since migration 031 and, until that '
      + 'day, gated by NOTHING: speech recognition runs on-device so there is no route to '
      + 'gate, and the mic button was gated on device readiness alone. Removing the key in '
      + 'admin therefore could not change anything on a paying customer\'s phone. The mic '
      + 'now checks this key (see the mobile registry, lib/constants/feature_keys.dart) and '
      + 'the drift audit fails if that check is ever removed again. There is nothing to '
      + 'enforce server-side; a client gate is the whole gate, which is exactly why it has '
      + 'to be declared and tested.',
  },
  {
    key: 'daily_closing',
    label: 'Day-end closing',
    group: 'Kitchen & ops',
    enforcement: 'route',
  },
  {
    key: 'surge_pricing',
    label: 'Surge / happy-hour pricing',
    group: 'Kitchen & ops',
    enforcement: 'route',
  },

  // ── Delivery ───────────────────────────────────────────────────────────
  {
    key: 'driver_mode',
    label: 'Driver app & assignments',
    group: 'Delivery',
    enforcement: 'route',
  },
  {
    key: 'aggregators',
    label: 'Aggregator orders (online)',
    group: 'Delivery',
    enforcement: 'route',
  },
  {
    key: 'qr_ordering',
    label: 'QR self-ordering',
    group: 'Delivery',
    enforcement: 'route',
  },

  // ── Customers & marketing ──────────────────────────────────────────────
  {
    key: 'customers_basic',
    label: 'Customer directory',
    group: 'Customers & marketing',
    enforcement: 'client',
    clients: ['mobile'],
    note: 'The dashboard does NOT gate its customers page on this key — it is mobile-only '
      + 'today. Do not add "dashboard" here without adding the check.',
  },
  {
    key: 'customers_crm',
    label: 'Customer CRM (segments, history)',
    group: 'Customers & marketing',
    enforcement: 'ungated',
    why: 'The CRM screens are the customer directory screens; nothing branches on this '
      + 'key on either side of the wire. It differentiates plan cards only. Either wire '
      + 'a gate to it or stop selling it as a separate line — recorded so the choice '
      + 'is made deliberately.',
  },
  {
    key: 'loyalty',
    label: 'Loyalty points & wallet',
    group: 'Customers & marketing',
    enforcement: 'route',
    note: 'Also checked directly by orderService and tableService before accruing '
      + 'points, and by requireAddon(orFeature) on /customers.',
  },
  {
    key: 'memberships',
    label: 'Memberships / prepaid packs',
    group: 'Customers & marketing',
    enforcement: 'route',
  },
  {
    key: 'reviews',
    label: 'Customer reviews',
    group: 'Customers & marketing',
    enforcement: 'route',
  },
  {
    key: 'whatsapp_marketing',
    label: 'WhatsApp marketing',
    group: 'Customers & marketing',
    enforcement: 'route',
  },
  {
    key: 'auto_whatsapp_order',
    label: 'Automatic WhatsApp order updates',
    group: 'Customers & marketing',
    enforcement: 'service',
    note: 'orderService checks it before sending the confirmation message.',
  },

  // ── Reports ────────────────────────────────────────────────────────────
  {
    key: 'reports_basic',
    label: 'Basic reports',
    group: 'Reports',
    enforcement: 'client',
    clients: ['dashboard'],
  },
  {
    key: 'registers',
    label: 'Registers (sales / cash / expense)',
    group: 'Reports',
    enforcement: 'client',
    clients: ['mobile'],
  },
  {
    key: 'pnl_statement',
    label: 'P&L statement',
    group: 'Reports',
    enforcement: 'client',
    clients: ['mobile'],
    note: 'The route-level check on /reports/pnl is requireStaffPerm(\'pnl_statement\') — '
      + 'a STAFF PERMISSION that happens to share the string, not a plan gate. Do not '
      + 'mistake one for the other.',
  },
  {
    key: 'heat_map',
    label: 'Sales heat-map',
    group: 'Reports',
    enforcement: 'route',
  },
  {
    key: 'forecast',
    label: 'Sales forecast & upsell',
    group: 'Reports',
    enforcement: 'route',
  },

  // ── Billing & accounting ───────────────────────────────────────────────
  {
    key: 'invoice_basic',
    label: 'Basic invoices',
    group: 'Billing & accounting',
    enforcement: 'client',
    clients: ['dashboard'],
  },
  {
    key: 'tax_invoices',
    label: 'GST tax invoices',
    group: 'Billing & accounting',
    enforcement: 'client',
    clients: ['mobile'],
    note: "requireStaffPerm('tax_invoices') on the route is a STAFF PERMISSION sharing "
      + 'the string, not a plan gate.',
  },
  {
    key: 'b2b_invoice',
    label: 'B2B invoices',
    group: 'Billing & accounting',
    enforcement: 'middleware',
    note: "2026-09-06 (review D-04): requireFeature('b2b_invoice') on GET/PUT "
      + '/b2b-invoice-template (routes/b2bTemplate.routes.js, migration 095). The '
      + 'dashboard page used to write the RECEIPT template and 402 on save below '
      + 'Enterprise; it now has its own store gated on this key. The dashboard nav '
      + 'also checks the key.',
  },
  {
    key: 'einvoice_gst',
    label: 'GST e-invoice (GSP connection required)',
    group: 'Billing & accounting',
    enforcement: 'route',
    note: 'The key is a real gate; the IRP integration behind it is not connected in '
      + 'production — see CREDENTIAL_GATED in scripts/marketing-claims.js.',
  },
  {
    key: 'recurring_invoices',
    label: 'Recurring invoices',
    group: 'Billing & accounting',
    enforcement: 'route',
    note: '2026-09-06: BUILT. Until 2026-09-05 no implementation existed (the old rule '
      + "'/recurring-invoice' matched zero routes and the dashboard page said 'use the "
      + "API'). Now routes/recurringInvoices.routes.js (CRUD + run-now) under "
      + "'/recurring-invoices', generated by cronWorker.dueRecurringInvoices via "
      + 'taxInvoiceService. Sold on Advanced and Enterprise.',
  },
  {
    key: 'accounting_pnl_bs',
    label: 'Accounting (P&L + balance sheet)',
    group: 'Billing & accounting',
    enforcement: 'route',
  },
  {
    key: 'bank_reconcile',
    label: 'Bank reconciliation',
    group: 'Billing & accounting',
    enforcement: 'route',
  },
  {
    key: 'tds_tcs',
    label: 'TDS / TCS',
    group: 'Billing & accounting',
    enforcement: 'route',
  },
  {
    key: 'multi_currency_fx',
    label: 'Multi-currency / FX',
    group: 'Billing & accounting',
    enforcement: 'route',
  },

  // ── Advanced ───────────────────────────────────────────────────────────
  {
    key: 'multi_outlet',
    label: 'Multi-outlet',
    group: 'Advanced',
    enforcement: 'route',
    note: 'Also checked directly in multiOutlet.routes.js, which mirrors the 402 shape '
      + 'because outlet creation sits outside the /businesses/:id prefix the gate '
      + 'is mounted on.',
  },
  {
    key: 'marketplace_addons',
    label: 'Add-on marketplace',
    group: 'Advanced',
    enforcement: 'ungated',
    why: '2026-09-05 (entitlements review B8): the featureGate rule on \'/marketplace\' '
      + 'matched no route and is deleted. The add-on marketplace itself is /addons, which '
      + 'featureGate exempts ON PURPOSE — gating the checkout that grants features would '
      + 'lock a tenant out of buying their way in. services/marketplaceService.js '
      + '(Amazon/Flipkart listings) has no route. Neither client checks this key (the '
      + 'mobile registry declares it ungatedByDesign). It differentiates plan cards only; '
      + 'either wire a real surface to it or stop granting it.',
  },
  {
    key: 'api_access',
    label: 'API access',
    group: 'Advanced',
    enforcement: 'middleware',
    note: "2026-09-06: BUILT. requireFeature('api_access') on /api-keys (issue/list/revoke, "
      + 'migration 097) and middleware/auth.js accepts X-API-Key for READ-ONLY business '
      + 'calls; a key whose plan lost this feature gets 403 API_ACCESS_NOT_IN_PLAN. Until '
      + 'today nothing read this key.',
  },
  {
    key: 'white_label',
    label: 'White-label branding',
    group: 'Advanced',
    enforcement: 'service',
    note: "2026-09-06: BUILT. requireFeature('white_label') on GET/PUT /white-label "
      + '(businesses.white_label, migration 098); guest QR pages, the public site and '
      + 'receipt/invoice PDFs re-check hasFeature at render time before hiding "Powered '
      + 'by NamastePOS" and using the brand name. custom_branding stays the bill-template '
      + 'capability.',
  },
]);

const BY_KEY = Object.freeze(FEATURES.reduce((acc, f) => {
  acc[f.key] = f;
  return acc;
}, Object.create(null)));

const KEYS = Object.freeze(FEATURES.map((f) => f.key));
const KEY_SET = new Set(KEYS);

/** Every registered key, sorted — the admin catalog's backbone. */
function keys() {
  return [...KEYS].sort();
}

/** True when `key` is a registered feature key. */
function isKnown(key) {
  return typeof key === 'string' && KEY_SET.has(key);
}

/** The registry entry for `key`, or null. */
function get(key) {
  return BY_KEY[key] || null;
}

/** Owner-facing label; falls back to the raw key so an unknown key still renders. */
function labelOf(key) {
  return (BY_KEY[key] && BY_KEY[key].label) || key;
}

/** Every key whose declared enforcement is one of `kinds`. */
function keysWithEnforcement(...kinds) {
  const want = new Set(kinds);
  return FEATURES.filter((f) => want.has(f.enforcement)).map((f) => f.key).sort();
}

/**
 * The catalog rows the admin console renders: key, label, group, enforcement.
 * `group` is used for section headings, `enforcement` lets the console warn
 * that a key it is about to grant is not actually enforced anywhere.
 */
function catalog() {
  return FEATURES.map((f) => ({
    key: f.key,
    label: f.label,
    group: f.group,
    enforcement: f.enforcement,
    ...(f.why ? { why: f.why } : {}),
  }));
}

module.exports = {
  GROUPS,
  FEATURES,
  keys,
  isKnown,
  get,
  labelOf,
  keysWithEnforcement,
  catalog,
};
