// NamastePOS — the ONE place a plan feature key may be named in this app.
//
// WHY THIS FILE EXISTS
// 2026-09-05: the founder removed Voice POS from the Enterprise plan in the
// admin console and a paying customer's phone kept showing the mic. The mic
// was gated on `VoiceOrderService.offerMicButton` — a DEVICE-capability check
// (is there a recogniser, is permission granted) — and on nothing else. There
// was no entitlement check anywhere in the voice path, so a feature the
// customer was no longer paying for stayed on their counter.
//
// The bug was not "someone forgot an if". It was that a feature could be
// added to the app without anything, anywhere, forcing the question "which
// plan key turns this on?". This file is that forcing function:
//
//   1. Every gate call site passes a `Features.` constant, never a string
//      literal. A typo is then a compile error rather than a permanent
//      grant. `test/entitlements_test.dart` fails the build on any literal.
//   2. [kFeatureCatalog] must match the backend's WELL_KNOWN_FEATURE_KEYS
//      (namastepos_backend/src/services/featureService.js) exactly. Add a key
//      there and the mobile test goes red until someone classifies it below.
//   3. [kMobileSurfaces] records, for every key, whether the app shows UI for
//      it and whether that UI is gated. The test asserts the record against
//      the actual call sites, so deleting a gate — or adding one for a key
//      marked "no surface" — trips the build.
//
// THE TIER-CODE TRAP — read before touching anything plan-related.
// `plans.tier` codes are NOT the plan names:
//     free = Starter, basic = Growth, pro_plan = Pro, advanced = Advanced,
//     and `pro` = ENTERPRISE.
// So the seed line ('pro', 'voice_pos') grants voice to Enterprise, not Pro.
// NEVER gate on a tier code or tier kind. Gate on the FEATURE KEY, which is
// what the founder actually edits in the admin console and what /auth/me
// resolves per business (plan matrix + addon grants + per-business
// overrides). See models/plan_info.dart.

/// Every feature key the live plan feed can grant.
///
/// Mirrors `WELL_KNOWN_FEATURE_KEYS` in
/// `namastepos_backend/src/services/featureService.js`. Keep the two in step:
/// `test/entitlements_test.dart` parses that file and fails if they diverge.
class Features {
  const Features._();

  // ── Starter core ────────────────────────────────────────────────────────
  static const String pos = 'pos';
  static const String orders = 'orders';
  static const String tokenGeneration = 'token_generation';
  static const String tablesSingleFloor = 'tables_single_floor';
  static const String menuBasic = 'menu_basic';
  static const String reportsBasic = 'reports_basic';
  static const String expenses = 'expenses';
  static const String invoiceBasic = 'invoice_basic';
  static const String staffLite = 'staff_lite';
  static const String customersBasic = 'customers_basic';

  // ── Growth / Pro additions ──────────────────────────────────────────────
  static const String tablesMultiFloor = 'tables_multi_floor';
  static const String menuVariantsModifiers = 'menu_variants_modifiers';
  static const String kds = 'kds';
  static const String captainMode = 'captain_mode';
  static const String driverMode = 'driver_mode';
  static const String loyalty = 'loyalty';
  static const String customersCrm = 'customers_crm';
  static const String aggregators = 'aggregators';
  static const String reservations = 'reservations';
  static const String wastage = 'wastage';
  static const String dailyClosing = 'daily_closing';
  static const String b2bInvoice = 'b2b_invoice';
  static const String qrOrdering = 'qr_ordering';
  static const String whatsappMarketing = 'whatsapp_marketing';
  static const String autoWhatsappOrder = 'auto_whatsapp_order';
  static const String recipeCosting = 'recipe_costing';
  static const String billSplit = 'bill_split';
  static const String staffUnlimited = 'staff_unlimited';
  static const String voicePos = 'voice_pos';
  static const String inventoryTracking = 'inventory_tracking';
  static const String taxInvoices = 'tax_invoices';
  static const String pnlStatement = 'pnl_statement';
  static const String registers = 'registers';
  static const String memberships = 'memberships';
  static const String reviews = 'reviews';

  // ── Enterprise additions ────────────────────────────────────────────────
  static const String multiOutlet = 'multi_outlet';
  static const String accountingPnlBs = 'accounting_pnl_bs';
  static const String einvoiceGst = 'einvoice_gst';
  static const String recurringInvoices = 'recurring_invoices';
  static const String bankReconcile = 'bank_reconcile';
  static const String surgePricing = 'surge_pricing';
  static const String heatMap = 'heat_map';
  static const String forecast = 'forecast';
  static const String deadStock = 'dead_stock';
  static const String bulkImport = 'bulk_import';
  static const String apiAccess = 'api_access';
  static const String whiteLabel = 'white_label';
  static const String tdsTcs = 'tds_tcs';
  static const String multiCurrencyFx = 'multi_currency_fx';
  static const String marketplaceAddons = 'marketplace_addons';
  static const String customBranding = 'custom_branding';
  static const String dashboardAccess = 'dashboard_access';
}

/// What the mobile app does about a key.
enum MobileSurface {
  /// The app renders UI for this feature AND gates that UI on the key.
  /// The test asserts a real call site exists.
  gated,

  /// The app has no UI for this feature at all (dashboard-only, server-only,
  /// or simply not built for mobile yet). The test asserts NO call site
  /// exists — the moment someone builds the screen and gates it, this entry
  /// must be flipped to [gated], which is the point.
  noSurface,

  /// The app renders UI and deliberately does NOT gate it. Every entry here
  /// carries a reason. This is the only honest way to have an ungated
  /// surface: it has to be written down and defended, not forgotten.
  ungatedByDesign,
}

class FeatureSurface {
  final MobileSurface kind;

  /// Where the gate lives (for [MobileSurface.gated]) or why there isn't one.
  final String note;

  const FeatureSurface(this.kind, this.note);
}

/// Every catalog key, and what mobile does about it. Audited 2026-09-05.
///
/// `test/entitlements_test.dart` checks this map against the real call sites
/// in `lib/`, so it cannot rot silently.
const Map<String, FeatureSurface> kMobileSurfaces = <String, FeatureSurface>{
  // ── Baseline keys: granted by every plan today, no mobile switch ────────
  // These are ungated on the server too (featureGate.js has no rule for
  // them), so a mobile-only gate would be theatre — and locking POS itself
  // out of a POS app is a product decision, not a bug fix.
  Features.pos:
      FeatureSurface(MobileSurface.ungatedByDesign, 'The app itself. No server rule either.'),
  Features.orders:
      FeatureSurface(MobileSurface.ungatedByDesign, 'Baseline. No server rule.'),
  Features.tokenGeneration:
      FeatureSurface(MobileSurface.ungatedByDesign, 'Baseline token print. No server rule.'),
  Features.tablesSingleFloor:
      FeatureSurface(MobileSurface.ungatedByDesign, 'Baseline tables. No server rule.'),
  Features.menuBasic:
      FeatureSurface(MobileSurface.ungatedByDesign, 'Baseline menu. No server rule.'),
  Features.reportsBasic: FeatureSurface(MobileSurface.gated,
      'staff_screen permission checkboxes (report perms need this key)'),
  Features.expenses:
      FeatureSurface(MobileSurface.ungatedByDesign, 'Baseline; drawer gates on the STAFF permission.'),
  Features.invoiceBasic: FeatureSurface(MobileSurface.gated,
      'staff_screen permission checkbox (tax_invoices perm needs this key)'),
  Features.staffLite:
      FeatureSurface(MobileSurface.ungatedByDesign, 'Headcount claim; enforced by plans.limits.staff.'),

  // ── Gated surfaces ──────────────────────────────────────────────────────
  Features.customersBasic: FeatureSurface(MobileSurface.gated,
      'customers/customers_screen.dart + utils/checkout_gates.dart (customer attach at both checkouts)'),
  Features.menuVariantsModifiers: FeatureSurface(MobileSurface.gated,
      'home_screen drawer (Modifier groups) + menu_editor_screen variants block'),
  Features.kds: FeatureSurface(MobileSurface.gated,
      'home_screen drawer tile AND the Home/Kitchen tab'),
  Features.captainMode: FeatureSurface(MobileSurface.gated,
      'home_screen drawer tile AND the Tables bottom-nav tab'),
  Features.driverMode:
      FeatureSurface(MobileSurface.gated, 'home_screen drawer tile'),
  Features.loyalty: FeatureSurface(MobileSurface.gated,
      'home_screen drawer (Coupons) + utils/checkout_gates.dart (points/wallet at Pay & Place and captain settle)'),
  Features.aggregators:
      FeatureSurface(MobileSurface.gated, 'settings_screen'),
  Features.reservations:
      FeatureSurface(MobileSurface.gated, 'home_screen drawer tile'),
  Features.wastage:
      FeatureSurface(MobileSurface.gated, 'home_screen drawer tile'),
  Features.dailyClosing:
      FeatureSurface(MobileSurface.gated, 'home_screen drawer tile'),
  Features.qrOrdering:
      FeatureSurface(MobileSurface.gated, 'home_screen drawer tile'),
  Features.autoWhatsappOrder: FeatureSurface(MobileSurface.gated,
      'settings_screen + confirm_order_screen + orders_screen + order_detail_screen WhatsApp button'),
  Features.billSplit: FeatureSurface(MobileSurface.gated,
      'captain_screen Split button'),
  Features.voicePos: FeatureSurface(MobileSurface.gated,
      'pos/new_order_screen mic (device readiness AND this key)'),
  Features.inventoryTracking:
      FeatureSurface(MobileSurface.gated, 'home_screen drawer tile'),
  Features.taxInvoices: FeatureSurface(MobileSurface.gated,
      'home_screen drawer tile + tax_invoices_screen DESTINATION gate (list + detail) + register_reports_screen Invoices tab'),
  Features.pnlStatement: FeatureSurface(MobileSurface.gated,
      'home_screen drawer tile + dashboard_screen KPI taps'),
  Features.registers:
      FeatureSurface(MobileSurface.gated, 'home_screen drawer tile'),
  Features.memberships: FeatureSurface(MobileSurface.gated,
      'home_screen drawer tile + membership_offer_dialog + utils/checkout_gates.dart (offer at both checkouts)'),
  Features.reviews:
      FeatureSurface(MobileSurface.gated, 'home_screen drawer tile'),
  Features.einvoiceGst:
      FeatureSurface(MobileSurface.gated, 'orders_screen IRN action'),
  Features.surgePricing: FeatureSurface(MobileSurface.gated,
      'home_screen drawer tile + confirm_order_screen (skip /surge/current fetch)'),
  Features.customBranding:
      FeatureSurface(MobileSurface.gated, 'home_screen drawer (Bill template)'),

  // ── Ungated surfaces, on purpose ────────────────────────────────────────
  Features.tablesMultiFloor: FeatureSurface(MobileSurface.ungatedByDesign,
      'Floors & tables editor. /ops/floors carries NO server rule (featureGate.js), '
      'and a single-floor tenant still needs the editor to rename its one floor. '
      'Gate the ADD-FLOOR action, not the screen, if this is ever enforced.'),
  Features.whatsappMarketing: FeatureSurface(MobileSurface.gated,
      'staff_screen permission checkbox. NOTE: whatsapp_service itself only opens '
      'a wa.me deep link — no NamastePOS server call, nothing to entitle at send '
      'time. The gated send path is auto_whatsapp_order.'),
  Features.marketplaceAddons: FeatureSurface(MobileSurface.ungatedByDesign,
      'The Marketplace tile hits /addons, which featureGate.js exempts on purpose: '
      'gating the checkout that GRANTS features would be self-defeating. The '
      'marketplace_addons key gates /marketplace, which mobile never calls.'),

  // ── No mobile surface ───────────────────────────────────────────────────
  Features.customersCrm:
      FeatureSurface(MobileSurface.noSurface, 'CRM notes are dashboard-only.'),
  Features.b2bInvoice:
      FeatureSurface(MobileSurface.noSurface, 'Dashboard-only.'),
  Features.recipeCosting: FeatureSurface(MobileSurface.noSurface,
      'Mobile never calls /recipes or /ingredients; wastage costing is server-side.'),
  Features.staffUnlimited: FeatureSurface(MobileSurface.noSurface,
      'A CLAIM, not a gate. Nothing branches on it; plans.limits.staff is the cap.'),
  Features.multiOutlet:
      FeatureSurface(MobileSurface.noSurface, 'Outlet management is dashboard-only.'),
  Features.accountingPnlBs: FeatureSurface(MobileSurface.noSurface,
      'Mobile P&L uses /reports/income-statement (gated on pnl_statement), not /accounting/.'),
  Features.recurringInvoices:
      FeatureSurface(MobileSurface.noSurface, 'Dashboard-only.'),
  Features.bankReconcile:
      FeatureSurface(MobileSurface.noSurface, 'Dashboard-only.'),
  Features.heatMap:
      FeatureSurface(MobileSurface.noSurface, 'Dashboard-only.'),
  Features.forecast:
      FeatureSurface(MobileSurface.noSurface, 'Dashboard-only.'),
  Features.deadStock:
      FeatureSurface(MobileSurface.noSurface, 'Dashboard-only.'),
  Features.bulkImport:
      FeatureSurface(MobileSurface.noSurface, 'Dashboard-only.'),
  Features.apiAccess:
      FeatureSurface(MobileSurface.noSurface, 'Developer API; no app UI.'),
  Features.whiteLabel:
      FeatureSurface(MobileSurface.noSurface, 'Server-rendered branding.'),
  Features.tdsTcs:
      FeatureSurface(MobileSurface.noSurface, 'Dashboard-only.'),
  Features.multiCurrencyFx:
      FeatureSurface(MobileSurface.noSurface, 'Dashboard-only.'),
  Features.dashboardAccess: FeatureSurface(MobileSurface.noSurface,
      'Gates the WEB dashboard login, not this app.'),
};

/// Every key the plan feed can grant. Derived from the surface map so the two
/// can never disagree.
final Set<String> kFeatureCatalog = kMobileSurfaces.keys.toSet();
