// NamastePOS — role fallback map parity + money visibility (2026-09-05,
// review #6 / #8).
//
// The fallback map in role_permissions.dart is only consulted when the server
// sent no explicit permission list, but its own comment says it "must not
// disagree" with staffService.DEFAULT_PERMS_BY_ROLE. These lists are copied
// from that file (read-only) on 2026-09-05; if the backend changes, update
// both and this test in one commit.

import 'package:flutter_test/flutter_test.dart';
import 'package:namastepos/utils/role_permissions.dart';

const _backendDefaults = <String, List<String>>{
  'staff_manager': [
    'home', 'pos', 'orders', 'tables', 'reports',
    'pnl_statement', 'income_register', 'expense_register',
    'invoice_register', 'tax_invoices',
    'menu_editor', 'modifier_groups',
    'customers', 'reservations',
    'wastage', 'daily_closing',
    'kds', 'captain', 'driver',
    'surge', 'qr_codes',
    'bill_template', 'thermal_printer', 'aggregators',
    'whatsapp_marketing', 'auto_whatsapp_order',
    'expenses',
  ],
  'staff_captain': ['home', 'pos', 'orders', 'tables', 'customers', 'captain'],
  'staff_waiter': ['home', 'pos', 'tables', 'captain'],
  'staff_cashier': [
    'home', 'pos', 'orders', 'reports',
    'tax_invoices', 'invoice_register',
    'customers', 'bill_template',
    'expenses',
  ],
  'staff_kitchen': ['home', 'kds'],
  'staff_driver': ['home', 'driver'],
};

/// Areas that exist only on mobile (the More tab, two drawer areas the
/// backend gates by role rather than by key). Allowed to be extra here.
const _mobileOnlyAreas = {'settings', 'reviews', 'memberships'};

/// What AuthProvider.canSeeMoney asks, expressed against the fallback map.
bool _canSeeMoney(String role) =>
    role == 'business_owner' ||
    RolePerms.can(role, 'reports') ||
    RolePerms.can(role, 'pnl_statement') ||
    RolePerms.can(role, 'income_register');

void main() {
  group('fallback map matches staffService.DEFAULT_PERMS_BY_ROLE', () {
    _backendDefaults.forEach((role, areas) {
      test('$role grants every backend default', () {
        final missing =
            areas.where((a) => !RolePerms.can(role, a)).toList();
        expect(missing, isEmpty,
            reason: '$role fallback lacks: $missing');
      });

      test('$role grants nothing the backend does not (mobile-only aside)',
          () {
        // Probe with the union of every backend key + the mobile-only set.
        final universe = {
          for (final l in _backendDefaults.values) ...l,
          ..._mobileOnlyAreas,
          'billing', 'staff', 'floors',
        };
        final extra = universe
            .where((a) => RolePerms.can(role, a))
            .where((a) => !areas.contains(a) && !_mobileOnlyAreas.contains(a))
            .toList();
        expect(extra, isEmpty, reason: '$role fallback over-grants: $extra');
      });
    });
  });

  group('money visibility (review #6)', () {
    test('captain and waiter cannot see money', () {
      expect(_canSeeMoney('staff_captain'), isFalse);
      expect(_canSeeMoney('staff_waiter'), isFalse);
      expect(_canSeeMoney('staff_kitchen'), isFalse);
      expect(_canSeeMoney('staff_driver'), isFalse);
    });

    test('owner, manager and cashier can', () {
      expect(_canSeeMoney('business_owner'), isTrue);
      expect(_canSeeMoney('staff_manager'), isTrue);
      expect(_canSeeMoney('staff_cashier'), isTrue);
    });

    test('an explicit permission list overrides the role default', () {
      expect(
          RolePerms.can('staff_captain', 'reports', permissions: ['reports']),
          isTrue);
      expect(
          RolePerms.can('staff_manager', 'reports', permissions: ['pos']),
          isFalse);
    });

    test('unknown role grants nothing', () {
      expect(RolePerms.can('', 'home'), isFalse);
      expect(RolePerms.can('staff_nobody', 'home'), isFalse);
    });
  });
}
