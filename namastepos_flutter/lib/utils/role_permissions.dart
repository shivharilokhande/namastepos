// NamastePOS — Role → permissions map (Push 14b).
//
// Single source of truth for "what can this role see / do". Mobile drawer
// + bottom nav filter through this. Backend `requireRole` middleware is
// the authoritative enforcement — this just prevents staff from seeing
// menus they couldn't use anyway, and surfaces a cleaner UX per role.
//
// Roles (from backend user_role enum):
//   business_owner  → unrestricted
//   staff_manager   → almost everything except billing + staff create
//   staff_captain   → tables, orders (take + ready), customers
//   staff_waiter    → tables, orders (take only)
//   staff_cashier   → orders (settle), bills, expenses, customers
//   staff_kitchen   → KDS only

class RolePerms {
  /// True if the role is allowed to see the named area.
  ///
  /// Push 14c: callers should now pass `permissions` (the explicit list
  /// from AuthProvider). If non-empty, it's the authoritative allowlist.
  /// If null/empty, fall back to the role's hardcoded defaults below —
  /// keeps legacy logins working before the column is populated.
  /// NP-201: an UNKNOWN role (empty string — see `AuthProvider.role`, which
  /// no longer defaults to owner) grants nothing. Only the literal
  /// 'business_owner' unlocks everything; every other value must earn each
  /// area from an explicit permission list or from [_MAP]. Do not add a
  /// permissive default here.
  static bool can(String role, String area, {List<String>? permissions}) {
    if (role == 'business_owner') return true;
    if (role.isEmpty) return false; // role not yet known → least privilege
    if (permissions != null && permissions.isNotEmpty) {
      return permissions.contains(area);
    }
    final allowed = _MAP[role];
    if (allowed == null) return false;
    return allowed.contains(area);
  }

  /// Each role's allowed areas. Used by the drawer + bottom-nav filter.
  ///
  /// 2026-09-05 (review #8): re-synced with the backend's
  /// `staffService.DEFAULT_PERMS_BY_ROLE`, which is the authority. Keys that
  /// exist ONLY on mobile ('settings' = the More tab, 'reviews' and
  /// 'memberships' = drawer areas the backend gates by role, not by key) are
  /// kept and marked; everything else must match the server list exactly.
  static const _MAP = <String, Set<String>>{
    'staff_manager': {
      'home', 'pos', 'orders', 'tables', 'reports',
      // review #8: the manager's reporting + compliance keys the server
      // grants by default and the mobile fallback lacked.
      'pnl_statement', 'income_register', 'expense_register',
      'invoice_register', 'tax_invoices',
      'menu_editor', 'modifier_groups', 'customers', 'reservations',
      'wastage', 'daily_closing', 'kds', 'captain', 'driver',
      'surge', 'qr_codes', 'bill_template',
      // review #8: also missing vs the server list.
      'thermal_printer', 'aggregators',
      'whatsapp_marketing', 'auto_whatsapp_order',
      // NP-201: a manager books and reviews expenses. Only used when the
      // server sends no explicit list, but the two tables must not disagree.
      'expenses',
      // mobile-only area keys (no backend equivalent):
      'settings', 'reviews', 'memberships',
      // Manager CAN'T do plans & billing (money decisions) or staff create.
    },
    'staff_captain': {
      'home', 'pos', 'orders', 'tables',
      'captain', 'customers',
    },
    'staff_waiter': {
      'home', 'pos', 'tables',
      'captain',
    },
    'staff_cashier': {
      'home', 'pos', 'orders', 'reports',
      // review #8 (2026-09-05): cashier handles bills + tax invoices
      // server-side ("gets reports but NOT P&L") — was missing here.
      'tax_invoices', 'invoice_register',
      'customers', 'bill_template',
      // Sync-fix (2026-08-22): backend FF-332 grants cashiers the
      // Expenses button (they book petty cash at the register). Was
      // missing here, so the mobile drawer hid the tile even though
      // the server accepted the call.
      'expenses',
    },
    'staff_kitchen': {
      'home', 'kds',
    },
    // 2026-08-22 — delivery rider: Home + the My-deliveries screen.
    'staff_driver': {
      'home', 'driver',
    },
  };

  /// Bottom-nav tabs visible to this role, in order.
  ///
  /// Owner: all 6 tabs.
  /// Staff: only tabs whose permission key is set. NEVER force-include
  /// Home — if the owner unchecks `home` for a kitchen cook, Home really
  /// disappears.
  ///
  /// More (settings) is always included so Sign Out is reachable.
  /// Home is only force-added as a last resort if the user would
  /// otherwise have just More (NavigationBar asserts >=2 destinations).
  static List<int> visibleTabs(String role, {List<String>? permissions}) {
    // Indices match HomeScreen._screens:
    // 0 Home, 1 POS, 2 Orders, 3 Tables, 4 Reports, 5 More
    if (role == 'business_owner') return const [0, 1, 2, 3, 4, 5];
    const tabKeys = ['home', 'pos', 'orders', 'tables', 'reports', 'settings'];
    final visible = <int>[];
    for (var i = 0; i < tabKeys.length; i++) {
      if (can(role, tabKeys[i], permissions: permissions)) visible.add(i);
    }
    // Settings is always reachable for Sign Out.
    if (!visible.contains(5)) visible.add(5);
    // Only force Home back in if the user would be left with just More.
    if (visible.length < 2 && !visible.contains(0)) visible.insert(0, 0);
    return visible;
  }
}
