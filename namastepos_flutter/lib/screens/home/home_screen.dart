// NamastePOS - Home shell with bottom navigation

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../models/business.dart';
import '../../providers/auth_provider.dart';
import '../../providers/expenses_provider.dart';
import '../../providers/menu_provider.dart';
import '../../providers/orders_provider.dart';
import '../../providers/subscription_provider.dart';
import '../../providers/tables_provider.dart';
// P0 fix (2026-08-22): _openDriver uses ApiService but the import was
// missing — compile error.
import '../../services/api_service.dart';
import '../captain/captain_screen.dart';
import '../customers/customers_screen.dart';
import '../driver/driver_screen.dart';
import '../kitchen/kds_screen.dart';
import '../menu/menu_editor_screen.dart';
import '../menu/modifier_groups_screen.dart';
import '../staff/staff_screen.dart';
import '../ops/daily_closing_screen.dart';
import '../ops/reservations_screen.dart';
import '../ops/wastage_screen.dart';
import '../settings/back_office_screens.dart';
import '../billing/billing_screen.dart';
import '../marketplace/marketplace_screen.dart';
import '../../utils/role_permissions.dart';
import '../../widgets/feature_tour.dart';
import '../../widgets/home_bottom_nav.dart';
import '../../widgets/home_drawer_button.dart';
import '../../widgets/plan_gate.dart';
import '../../widgets/trial_banner.dart';
import '../billing/trial_expired_screen.dart';
import '../inventory/inventory_screen.dart';
import '../ops/reviews_screen.dart';
import '../orders/orders_screen.dart';
import '../tables/tables_editor_screen.dart';
import '../pos/pos_screen.dart';
import '../reports/reports_screen.dart';
import '../reports/income_statement_screen.dart';
import '../reports/register_reports_screen.dart';
import '../invoices/tax_invoices_screen.dart';
import '../qr/qr_codes_screen.dart';
import '../settings/settings_screen.dart';
import 'dashboard_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

/// Lets any child screen pop open the home Drawer via
/// `homeScaffoldKey.currentState?.openDrawer()`.
final GlobalKey<ScaffoldState> homeScaffoldKey = GlobalKey<ScaffoldState>();

class _HomeScreenState extends State<HomeScreen> with WidgetsBindingObserver {
  // FF-402 restore-orphans pass 3 — tab index is now shared across
  // routes via the top-level `homeTabIndex` ValueNotifier so pushed
  // screens can flip the active tab from their own bottom nav bar.
  int get _index => homeTabIndex.value;
  set _index(int v) => homeTabIndex.value = v;
  bool _booted = false;
  VoidCallback? _tabListener;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // Rebuild HomeScreen whenever the shared tab notifier changes so the
    // IndexedStack switches even when a pushed screen flips the tab.
    _tabListener = () {
      if (mounted) setState(() {});
    };
    homeTabIndex.addListener(_tabListener!);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    if (_tabListener != null) {
      homeTabIndex.removeListener(_tabListener!);
    }
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      // When the user returns to the app, re-fetch everything that might
      // have changed in the dashboard/backend while the app was background.
      final biz = context.read<AuthProvider>().business;
      context.read<AuthProvider>().refreshPlan();
      if (biz != null) {
        context.read<MenuProvider>().refresh();
        context.read<OrdersProvider>().refresh();
        context.read<TablesProvider>().refresh();
        // Push 14d — refresh subscription so the over-limit banner on
        // the staff screen reflects super-admin changes (plan.limits.staff)
        // within seconds of the user returning to the app.
        context.read<SubscriptionProvider>().load(biz.id);
      }
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_booted) return;
    final biz = context.read<AuthProvider>().business;
    if (biz != null) {
      _booted = true;
      // Defer the provider fan-out until AFTER the first frame builds.
      // Each .load() starts by flipping _loading = true + notifyListeners();
      // if we fire that mid-build, HomeScreen (which watches some of these
      // providers) gets "setState() or markNeedsBuild() called during build"
      // warnings. addPostFrameCallback puts the wave just after first paint.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        // Push 16j — once we know the staff's permissions, point _index at
        // the first tab they can actually see (typically POS for captain,
        // KDS for kitchen). Without this they land on the empty welcome
        // placeholder until they tap a tab.
        final auth = context.read<AuthProvider>();
        final visible = RolePerms.visibleTabs(
          auth.role, permissions: auth.permissions);
        if (visible.isNotEmpty && !visible.contains(_index)) {
          setState(() => _index = visible.first);
        }
        // Refresh the plan first so plan-gated screens use the latest tier.
        auth.refreshPlan();
        // Every load() below pulls from BACKEND — local SQLite is fallback only.
        context.read<MenuProvider>().load(biz.id);
        context.read<OrdersProvider>().load(biz.id);
        context.read<TablesProvider>().load(biz.id);
        context.read<ExpensesProvider>().load(biz.id);
        context.read<SubscriptionProvider>().load(biz.id);
      });
    }
  }

  // Default tab set for owner/manager/captain/cashier/waiter. Kitchen
  // gets a stripped-down set built in _screensFor() below.
  static const _defaultScreens = <Widget>[
    DashboardScreen(),
    PosScreen(),
    OrdersScreen(),
    _CaptainTab(),
    ReportsScreen(),
    SettingsScreen(),
  ];

  /// Push 14c: per-role screen list driven by permissions.
  ///
  /// Home tab content is permission-sensitive: if the user has `home`
  /// permission they see the standard DashboardScreen with revenue
  /// stats; if they have `kds` instead (kitchen-only access) they land
  /// on the KDS board; if they have neither, they get a stripped
  /// "welcome" placeholder. This way a kitchen cook the owner has
  /// stripped of Home permission lands on the kitchen board they
  /// actually need.
  List<Widget> _screensFor(String role, List<String> perms) {
    if (role == 'business_owner') return _defaultScreens;
    final hasHome = perms.contains('home');
    final hasKds = perms.contains('kds');
    final Widget homeTab = hasHome
        ? const DashboardScreen()
        : hasKds
            ? const _KitchenTab()
            : const _WelcomeFallback();
    return [
      homeTab,
      const PosScreen(),
      const OrdersScreen(),
      const _CaptainTab(),
      const ReportsScreen(),
      const _MinimalMoreTab(),
    ];
  }

  /// Close the drawer WITHOUT touching the route stack.
  ///
  /// CRASH FIX (2026-08-23): every drawer tile used `Navigator.pop(context)`
  /// to dismiss the drawer. On a double-tap (easy when the next screen
  /// needs a network fetch), tap #1 popped the drawer's local history
  /// entry and tap #2 popped the ROOT ROUTE — leaving an empty navigator,
  /// i.e. the black screen the founder hit on "Driver (delivery)".
  /// closeDrawer() can never pop a route.
  void _closeDrawer() {
    final s = homeScaffoldKey.currentState;
    if (s != null && s.isDrawerOpen) s.closeDrawer();
  }

  void _openCaptain() {
    final biz = context.read<AuthProvider>().business;
    if (biz == null) return;
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => CaptainScreen(businessId: biz.id),
    ));
  }

  bool _driverSheetOpen = false; // re-entry guard (double-tap protection)

  Future<void> _openDriver() async {
    final biz = context.read<AuthProvider>().business;
    if (biz == null) return;
    if (_driverSheetOpen) return; // double-tap: one sheet at a time
    _driverSheetOpen = true;
    try {
      await _openDriverInner(biz);
    } finally {
      _driverSheetOpen = false;
    }
  }

  Future<void> _openDriverInner(Business biz) async {
    // Bug fix (2026-08-22): the earlier build asked the rider to
    // paste a UUID — nobody has a UUID handy, and owners opening
    // "Driver (delivery)" from the drawer had no idea what to type.
    // Now: fetch the drivers registered under this business and
    // let the user pick from a list. Empty list → show a helpful
    // empty state with the exact steps to add a driver from the
    // dashboard.
    List<dynamic> drivers;
    try {
      final r = await ApiService.instance.dio
          .get('/businesses/${biz.id}/drivers');
      drivers = (r.data['drivers'] as List?) ?? [];
    } catch (e) {
      if (!mounted) return;
      // P2 fix (2026-08-22): backend gates GET /drivers to
      // owner/manager/cashier — show a human message on 403 instead of
      // a raw DioException dump.
      final is403 = e.toString().contains('403');
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(is403
            ? 'Your role doesn\'t have access to the driver list. Ask the owner to open this screen.'
            : 'Could not load drivers. Check your connection and try again.'),
      ));
      return;
    }
    if (!mounted) return;
    final picked = await showModalBottomSheet<Map<String, dynamic>?>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (sheetCtx) => SafeArea(
        child: Container(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 16),
          constraints: BoxConstraints(
            maxHeight: MediaQuery.of(sheetCtx).size.height * 0.7,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('Pick a driver',
                  style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
              const SizedBox(height: 8),
              if (drivers.isEmpty) ...[
                const SizedBox(height: 12),
                const Icon(Icons.delivery_dining,
                    size: 44, color: AppColors.textHint),
                const SizedBox(height: 12),
                const Text(
                  'No drivers registered yet.',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: 4),
                const Text(
                  'Add one from Staff → Add staff → role "Driver (delivery)",\n'
                  'then reopen this screen.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: AppColors.textSecondary, fontSize: 12),
                ),
                const SizedBox(height: 16),
                TextButton(
                  onPressed: () => Navigator.pop(sheetCtx),
                  child: const Text('Close'),
                ),
              ] else
                Flexible(
                  child: ListView.separated(
                    shrinkWrap: true,
                    itemCount: drivers.length,
                    separatorBuilder: (_, __) => const Divider(height: 1),
                    itemBuilder: (_, i) {
                      final d = drivers[i] as Map<String, dynamic>;
                      final onDuty = d['isOnDuty'] == true;
                      return ListTile(
                        dense: true,
                        leading: CircleAvatar(
                          backgroundColor: onDuty
                              ? AppColors.success.withValues(alpha: 0.12)
                              : AppColors.divider,
                          child: Icon(Icons.delivery_dining,
                              color: onDuty
                                  ? AppColors.success
                                  : AppColors.textSecondary),
                        ),
                        title: Text(d['name'] as String? ?? 'Driver'),
                        subtitle: Text(
                          '${d['phone'] ?? ''} · ${d['vehicleType'] ?? 'bike'}'
                          '${onDuty ? " · on duty" : ""}',
                          style: const TextStyle(fontSize: 11),
                        ),
                        trailing: const Icon(Icons.chevron_right),
                        onTap: () => Navigator.pop(sheetCtx, d),
                      );
                    },
                  ),
                ),
            ],
          ),
        ),
      ),
    );
    if (picked == null || !mounted) return;
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => DriverScreen(
        businessId: biz.id,
        driverId: picked['id'] as String,
      ),
    ));
  }

  /// Compact uppercased section header inside the Drawer. Replaces the
  /// generic Dividers we used to scatter through the list — now sections
  /// have a label so the user can scan instead of reading every row.
  Widget _drawerSection(String label) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
        child: Text(
          label.toUpperCase(),
          style: const TextStyle(
            fontSize: 11,
            fontWeight: FontWeight.w900,
            color: AppColors.textSecondary,
            letterSpacing: 1.2,
          ),
        ),
      );

  @override
  Widget build(BuildContext context) {
    // Trial-expired hard gate — takes over the whole screen so the user
    // can't reach business tabs once the 14-day clock runs out. Lives here
    // (not in _RootGate) because SubscriptionProvider is loaded as part of
    // HomeScreen's didChangeDependencies, so by the time this build sees
    // a non-null subscription the data is trustworthy.
    final sub = context.watch<SubscriptionProvider>().subscription;
    if (sub?.trialExpired ?? false) {
      return const TrialExpiredScreen();
    }
    // Push 14b/14c: filter drawer items + bottom-nav tabs by the active
    // role + the user's explicit per-staff permissions (set by the owner
    // via the checkbox UI). When `permissions` is non-empty it's the
    // authoritative allowlist; otherwise we fall back to the role's
    // hardcoded defaults.
    final auth = context.watch<AuthProvider>();
    final role = auth.role;
    final perms = auth.permissions;
    bool _can(String area) => RolePerms.can(role, area, permissions: perms);

    return Scaffold(
      key: homeScaffoldKey,
      drawer: Drawer(
        child: SafeArea(
          child: ListView(
            padding: EdgeInsets.zero,
            children: [
              // Compact header — was a default 160dp DrawerHeader. Replaced
              // with a 78dp container that still shows the brand without
              // dominating the panel.
              Container(
                height: 78,
                width: double.infinity,
                color: AppColors.primary,
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 14),
                alignment: Alignment.bottomLeft,
                child: const Text(
                  'NamastePOS',
                  style: TextStyle(
                    color: Colors.white,
                    fontSize: 22,
                    fontWeight: FontWeight.w900,
                  ),
                ),
              ),

              if (role == 'business_owner' || _can('captain') || _can('driver') || _can('kds'))
                _drawerSection('Operations'),
              // Owner-only: manage floors + tables from mobile. Backend
              // has full CRUD on /ops/floors and /ops/tables — this
              // entry point wires it up so the owner doesn't need the
              // dashboard just to rename a floor or add a table.
              if (role == 'business_owner')
                ListTile(
                  dense: true,
                  leading: const Icon(Icons.grid_view_rounded),
                  title: const Text('Floors & tables'),
                  onTap: () {
                    _closeDrawer();
                    Navigator.push(context, MaterialPageRoute(
                      builder: (_) => const TablesEditorScreen(),
                    ));
                  },
                ),
              if (_can('captain'))
                PlanGate.tile(
                  featureKey: 'captain_mode',
                  icon: Icons.groups,
                  title: 'Captain (floor)',
                  onTap: () { _closeDrawer(); _openCaptain(); },
                ),
              if (_can('driver'))
                PlanGate.tile(
                  featureKey: 'driver_mode',
                  icon: Icons.delivery_dining,
                  title: 'Driver (delivery)',
                  onTap: () { _closeDrawer(); _openDriver(); },
                ),
              if (_can('kds'))
                PlanGate.tile(
                  featureKey: 'kds',
                  icon: Icons.restaurant,
                  title: 'Kitchen (KDS)',
                  onTap: () {
                    final biz = context.read<AuthProvider>().business;
                    if (biz == null) return;
                    Navigator.push(context, MaterialPageRoute(
                      builder: (_) => KdsScreen(businessId: biz.id),
                    ));
                  },
                ),

              if (_can('menu_editor') || _can('modifier_groups'))
                _drawerSection('Catalog'),
              if (_can('menu_editor'))
                ListTile(
                  dense: true,
                  leading: const Icon(Icons.restaurant_menu),
                  title: const Text('Menu editor'),
                  onTap: () {
                    _closeDrawer();
                    Navigator.push(context, MaterialPageRoute(
                      builder: (_) => const MenuEditorScreen(),
                    ));
                  },
                ),
              if (_can('modifier_groups'))
                PlanGate.tile(
                  featureKey: 'menu_variants_modifiers',
                  icon: Icons.tune,
                  title: 'Modifier groups',
                  onTap: () => Navigator.push(context, MaterialPageRoute(
                      builder: (_) => const ModifierGroupsScreen())),
                ),

              // FF-402 restore-orphans: Reviews screen re-linked (was
              // stripped in Push 17a but the code was left behind).
              if (_can('customers') || _can('reservations'))
                _drawerSection('Customers'),
              if (_can('customers'))
                ListTile(
                  dense: true,
                  leading: const Icon(Icons.people),
                  title: const Text('Customers'),
                  onTap: () {
                    _closeDrawer();
                    Navigator.push(context, MaterialPageRoute(
                      builder: (_) => const CustomersScreen(),
                    ));
                  },
                ),
              if (_can('customers'))
                ListTile(
                  dense: true,
                  leading: const Icon(Icons.reviews),
                  title: const Text('Reviews'),
                  onTap: () {
                    _closeDrawer();
                    Navigator.push(context, MaterialPageRoute(
                      builder: (_) => const ReviewsScreen(),
                    ));
                  },
                ),
              if (_can('reservations'))
                PlanGate.tile(
                  featureKey: 'reservations',
                  icon: Icons.event,
                  title: 'Reservations',
                  onTap: () => Navigator.push(context, MaterialPageRoute(
                      builder: (_) => const ReservationsScreen())),
                ),

              // Push 16a — each report has its own permission key so the
              // owner can grant them independently. Captain/waiter no
              // longer slip through via the broad 'orders' check.
              //
              // Plan-feature gating (Option B): each tile requires BOTH
              // the staff permission AND the plan-feature key. Source of
              // truth is `auth.has(key)` (backed by /auth/me's resolved
              // feature list from the plan_features table). Previously
              // used `sub?.plan?.features[k] == true` — that was the
              // JSONB template on the plans row, not the authoritative
              // effective list, so admin toggles on the feature picker
              // didn't reflect on mobile until a full re-login.
              // P2 fix (2026-08-22): header now uses auth.has() like the
              // tile below — the two sources could disagree (header
              // without tile, or tile without header).
              if ((_can('tax_invoices')      && (auth.has('tax_invoices'))) ||
                  (_can('pnl_statement')     && (auth.has('pnl_statement'))) ||
                  ((_can('income_register') || _can('expense_register') || _can('invoice_register'))
                       && (auth.has('registers'))))
                _drawerSection('Reports & invoices'),
              if (_can('tax_invoices') && (auth.has('tax_invoices')))
                ListTile(
                  dense: true,
                  leading: const Icon(Icons.receipt_long),
                  title: const Text('Tax invoices'),
                  onTap: () {
                    _closeDrawer();
                    Navigator.push(context, MaterialPageRoute(
                      builder: (_) => const TaxInvoicesScreen()));
                  },
                ),
              if (_can('pnl_statement') && (auth.has('pnl_statement')))
                ListTile(
                  dense: true,
                  leading: const Icon(Icons.account_balance_outlined),
                  title: const Text('P&L statement'),
                  onTap: () {
                    _closeDrawer();
                    Navigator.push(context, MaterialPageRoute(
                      builder: (_) => const IncomeStatementScreen()));
                  },
                ),
              // Push 17b — three register entries collapsed into one
              // "Registers" tile. Tap opens the tabbed RegisterReportsScreen
              // landing on whichever tab they have permission for first.
              if ((_can('income_register') || _can('expense_register') || _can('invoice_register'))
                  && (auth.has('registers')))
                ListTile(
                  dense: true,
                  leading: const Icon(Icons.list_alt),
                  title: const Text('Registers'),
                  onTap: () {
                    _closeDrawer();
                    // Pick the first tab the user has access to so they
                    // don't land on a locked screen they can't navigate
                    // away from gracefully.
                    final factory = _can('income_register')
                        ? RegisterReportsScreen.income
                        : _can('expense_register')
                            ? RegisterReportsScreen.expense
                            : RegisterReportsScreen.invoices;
                    Navigator.push(context, MaterialPageRoute(
                      builder: (_) => factory()));
                  },
                ),

              if (_can('wastage') || _can('daily_closing') || _can('inventory'))
                _drawerSection('Day-to-day'),
              // FF-402 restore-orphans: Inventory screen was imported
              // but never navigated. Wire it under a plan/permission
              // gate so it only shows when both the plan grants
              // `inventory_tracking` AND the staff role has permission.
              if (_can('inventory'))
                PlanGate.tile(
                  featureKey: 'inventory_tracking',
                  icon: Icons.inventory_2_outlined,
                  title: 'Inventory',
                  // Owner asked us to make sure Inventory is visibly
                  // routed even when the plan doesn't grant the feature
                  // yet — locked tile with an upgrade badge is better UX
                  // than a silently-missing menu entry.
                  showLockedAsUpgrade: true,
                  onTap: () => Navigator.push(context, MaterialPageRoute(
                      builder: (_) => const InventoryScreen())),
                ),
              if (_can('wastage'))
                PlanGate.tile(
                  featureKey: 'wastage',
                  icon: Icons.delete_outline,
                  title: 'Log wastage',
                  // Sync-fix (2026-08-22): match Inventory / Memberships
                  // — show the locked tile with an upgrade badge instead
                  // of silently hiding, so managers can see the feature
                  // exists and understand why it's not tappable.
                  showLockedAsUpgrade: true,
                  onTap: () => Navigator.push(context, MaterialPageRoute(
                      builder: (_) => const WastageScreen())),
                ),
              if (_can('daily_closing'))
                PlanGate.tile(
                  featureKey: 'daily_closing',
                  icon: Icons.point_of_sale,
                  title: 'Daily closing',
                  showLockedAsUpgrade: true,
                  onTap: () => Navigator.push(context, MaterialPageRoute(
                      builder: (_) => const DailyClosingScreen())),
                ),

              // FF-402 restore-orphans: Memberships re-linked. Was
              // removed in Push 16b but the screen (FF-1005 gift-card
              // + prepaid wallet) is still shipped. Behind the
              // `memberships` staff permission + `loyalty` plan feature.
              if (_can('surge') || _can('qr_codes') || _can('memberships'))
                _drawerSection('Enterprise'),
              if (_can('memberships'))
                PlanGate.tile(
                  featureKey: 'loyalty',
                  icon: Icons.card_membership,
                  title: 'Memberships',
                  // Show even when plan doesn't include `loyalty` yet —
                  // owner needs to see the option exists so they can
                  // decide to unlock it.
                  showLockedAsUpgrade: true,
                  onTap: () => Navigator.push(context, MaterialPageRoute(
                      builder: (_) => const MembershipsScreen())),
                ),
              if (_can('surge'))
                PlanGate.tile(
                  featureKey: 'surge_pricing',
                  icon: Icons.flash_on,
                  title: 'Surge pricing',
                  onTap: () => Navigator.push(context, MaterialPageRoute(
                      builder: (_) => const SurgeRulesScreen())),
                ),
              if (_can('qr_codes'))
                PlanGate.tile(
                  featureKey: 'qr_ordering',
                  icon: Icons.qr_code_2,
                  title: 'QR codes',
                  onTap: () => Navigator.push(context, MaterialPageRoute(
                      builder: (_) => const QrCodesScreen())),
                ),

              if (role == 'business_owner' || _can('bill_template'))
                _drawerSection('Settings'),
              // Staff CRUD: owner-only (managers can't add or remove team)
              if (role == 'business_owner')
                ListTile(
                  dense: true,
                  leading: const Icon(Icons.badge_outlined),
                  title: const Text('Staff'),
                  onTap: () {
                    _closeDrawer();
                    Navigator.push(context, MaterialPageRoute(
                      builder: (_) => const StaffScreen(),
                    ));
                  },
                ),
              if (_can('bill_template'))
                ListTile(
                  dense: true,
                  leading: const Icon(Icons.receipt_long),
                  title: const Text('Bill template'),
                  onTap: () {
                    _closeDrawer();
                    Navigator.push(context, MaterialPageRoute(
                      builder: (_) => const BillTemplateScreen(),
                    ));
                  },
                ),
              // FF-402 restore-orphans: upload logo/image (owner-only).
              if (role == 'business_owner')
                ListTile(
                  dense: true,
                  leading: const Icon(Icons.image_outlined),
                  title: const Text('Upload image / logo'),
                  onTap: () {
                    _closeDrawer();
                    Navigator.push(context, MaterialPageRoute(
                      builder: (_) => const ImageUploadScreen(),
                    ));
                  },
                ),
              // Marketplace + Plans & billing: owner-only (money decisions).
              // Marketplace lets the owner buy/cancel addons that grant
              // individual feature keys on top of their base plan.
              if (role == 'business_owner') const Divider(),
              if (role == 'business_owner')
                ListTile(
                  dense: true,
                  leading: const Icon(Icons.storefront, color: AppColors.primary),
                  title: const Text('Marketplace'),
                  onTap: () {
                    _closeDrawer();
                    Navigator.push(context, MaterialPageRoute(
                      builder: (_) => const MarketplaceScreen(),
                    ));
                  },
                ),
              if (role == 'business_owner')
                ListTile(
                  dense: true,
                  leading: const Icon(Icons.credit_card, color: AppColors.primary),
                  title: const Text('Plans & billing'),
                  onTap: () {
                    _closeDrawer();
                    Navigator.push(context, MaterialPageRoute(
                      builder: (_) => const BillingScreen(),
                    ));
                  },
                ),
              const Divider(),
              ListTile(
                dense: true,
                leading: const Icon(Icons.logout, color: AppColors.error),
                title: const Text('Sign out',
                    style: TextStyle(color: AppColors.error)),
                onTap: () async {
                  _closeDrawer();
                  await context.read<AuthProvider>().logout();
                },
              ),
            ],
          ),
        ),
      ),
      // Each child screen has its own AppBar with a HomeDrawerButton in
      // the leading slot — that's how users get to the side menu.
      // Body is wrapped in a Column so the trial countdown banner can pin
      // to the top of every tab. The banner widget self-hides outside trial.
      // SafeArea on the banner only (top: true) so it doesn't slide under
      // the iOS notch / status bar.
      //
      // MediaQuery.removePadding(removeTop: true) on the Expanded wrap:
      // each inner Scaffold's SliverAppBar reads MediaQuery.padding.top and
      // adds the status-bar inset on top of toolbarHeight. Since we already
      // consumed that inset for the trial banner, leaving it on would
      // double-pad and leave a ~47px white band between the banner and the
      // inner header. Removing it for the children only tells them "the
      // parent already handled the inset".
      // Feature tour (2026-08-25): Stack so the first-login tour card can
      // float above whichever tab is showing. Owner-only — staff roles
      // have restricted tabs the tour would point at uselessly.
      body: Stack(
        children: [
          Column(
            children: [
              const SafeArea(
                bottom: false,
                left: false,
                right: false,
                child: TrialBanner(),
              ),
              Expanded(
                child: MediaQuery.removePadding(
                  context: context,
                  removeTop: true,
                  child: Builder(builder: (_) {
                    final screens = _screensFor(role, perms);
                    // Push 16j — if Home isn't in this user's visible tabs
                    // (e.g. captain without 'home' perm), fall back to the
                    // first tab they DO have access to (typically POS).
                    // Without this they'd land on the empty welcome screen
                    // on first launch even though POS was a tap away.
                    final visible = RolePerms.visibleTabs(role, permissions: perms);
                    int idx = _index;
                    if (!visible.contains(idx)) {
                      idx = visible.isNotEmpty ? visible.first : 0;
                    }
                    if (idx >= screens.length) idx = 0;
                    return IndexedStack(index: idx, children: screens);
                  }),
                ),
              ),
            ],
          ),
          if (role == 'business_owner') const FeatureTour(),
        ],
      ),
      // FF-402 pass 3 — shared HomeBottomNav so drawer-pushed screens
      // can render the same bar without duplicating the logic here.
      // `popToHome: false` because we're already on HomeScreen — no
      // route to pop; just flip the tab.
      bottomNavigationBar: const HomeBottomNav(popToHome: false),
    );
  }
}

/// Wraps CaptainScreen so it can live inside the bottom-nav IndexedStack.
/// CaptainScreen itself takes a required businessId; we read it from the
/// AuthProvider so the tab works as soon as the user is logged in.
class _CaptainTab extends StatelessWidget {
  const _CaptainTab();

  @override
  Widget build(BuildContext context) {
    final biz = context.watch<AuthProvider>().business;
    if (biz == null) {
      return const Center(child: CircularProgressIndicator());
    }
    return CaptainScreen(businessId: biz.id);
  }
}

/// Push 14c: shown on the Home tab when a staff member has neither
/// `home` nor `kds` permission. NavigationBar forced Home back in to
/// satisfy its >=2 destinations assertion; this is what fills that slot.
class _WelcomeFallback extends StatelessWidget {
  const _WelcomeFallback();

  @override
  Widget build(BuildContext context) {
    final biz = context.watch<AuthProvider>().business;
    return Scaffold(
      appBar: AppBar(
        leading: (ModalRoute.of(context)?.isFirst ?? true) ? const HomeDrawerButton() : null,
        title: Text(biz?.name ?? 'NamastePOS'),
      ),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Icon(Icons.waves, size: 56, color: AppColors.textHint),
              const SizedBox(height: 12),
              Text('Welcome${biz != null ? " to ${biz.name}" : ""}',
                  style: const TextStyle(
                      fontSize: 18, fontWeight: FontWeight.w800)),
              const SizedBox(height: 6),
              const Text(
                'Use the side menu or the bottom tabs to navigate to '
                'the parts of the app you have access to.',
                textAlign: TextAlign.center,
                style: TextStyle(color: AppColors.textSecondary, fontSize: 13),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Push 14b: Kitchen staff's only landing surface — the live KDS ticket
/// board. Replaces the Home dashboard for kitchen role.
class _KitchenTab extends StatelessWidget {
  const _KitchenTab();

  @override
  Widget build(BuildContext context) {
    final biz = context.watch<AuthProvider>().business;
    if (biz == null) {
      return const Center(child: CircularProgressIndicator());
    }
    return KdsScreen(businessId: biz.id);
  }
}

/// Push 14b: minimal "More" tab for Kitchen — just shows the business
/// name and a Sign-out button. None of the owner settings (Business
/// info, Menu, Aggregators, etc) make sense for a cook.
class _MinimalMoreTab extends StatelessWidget {
  const _MinimalMoreTab();

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthProvider>();
    final biz = auth.business;
    return Scaffold(
      appBar: AppBar(
        leading: (ModalRoute.of(context)?.isFirst ?? true) ? const HomeDrawerButton() : null,
        title: const Text('More'),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: AppColors.primary.withValues(alpha: 0.08),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(biz?.name ?? 'Your business',
                    style: const TextStyle(
                        fontSize: 18, fontWeight: FontWeight.w900)),
                const SizedBox(height: 4),
                const Text(
                  'Kitchen staff view — see and update tickets from the '
                  'Kitchen tab.',
                  style: TextStyle(color: AppColors.textSecondary, fontSize: 13),
                ),
              ],
            ),
          ),
          const SizedBox(height: 24),
          ListTile(
            leading: const Icon(Icons.logout, color: AppColors.error),
            title: const Text('Sign out',
                style: TextStyle(
                    color: AppColors.error, fontWeight: FontWeight.w800)),
            onTap: () async {
              await context.read<AuthProvider>().logout();
            },
          ),
        ],
      ),
    );
  }
}
