// NamastePOS - Settings menu

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../config/app_config.dart';
import '../../constants/feature_keys.dart';
import '../../constants/colors.dart';
import '../../providers/auth_provider.dart';
import '../../providers/settings_provider.dart';
import '../customers/customers_screen.dart';
import '../expenses/expenses_screen.dart';
import '../menu/menu_editor_screen.dart';
import '../tables/tables_screen.dart';
import 'aggregators_screen.dart';
import 'business_info_screen.dart';
import '../../services/printer_service.dart';
import 'printer_setup_screen.dart';
import 'privacy_screen.dart';
import 'privacy_policy_screen.dart';
import '../../widgets/home_drawer_button.dart';

class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthProvider>();
    final biz = auth.business;
    // 2026-09-05 (review #14): this screen is now also the More tab for a
    // `staff_manager` (it used to be owner-only, so the tiles never asked).
    // Owner-only surfaces stay owner-only; everything else follows the same
    // staff permissions the drawer uses. `canDo` is true for the owner.
    final isOwner = auth.role == 'business_owner';
    bool can(String area) => auth.canDo(area);

    return Scaffold(
      appBar: AppBar(leading: (ModalRoute.of(context)?.isFirst ?? true) ? const HomeDrawerButton() : null, title: const Text('Settings')),
      body: ListView(
        children: [
          if (biz != null)
            Container(
              margin: const EdgeInsets.all(16),
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                gradient: const LinearGradient(
                  colors: [AppColors.primary, AppColors.primaryLight],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
                borderRadius: BorderRadius.circular(16),
              ),
              child: Row(
                children: [
                  Container(
                    width: 52, height: 52,
                    decoration: BoxDecoration(
                      color: Colors.white.withValues(alpha: 0.18),
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: const Icon(Icons.restaurant_menu_rounded,
                        color: Colors.white, size: 28),
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(biz.name,
                            style: const TextStyle(
                              color: Colors.white,
                              fontSize: 18, fontWeight: FontWeight.w800,
                            )),
                        Text(biz.phone,
                            style: const TextStyle(color: Colors.white70, fontSize: 13)),
                        if (biz.city != null)
                          Text(biz.city!,
                              style: const TextStyle(color: Colors.white70, fontSize: 12)),
                      ],
                    ),
                  ),
                ],
              ),
            ),

          _group('Business', [
            // Business profile: PATCH /me is open to owner + manager
            // server-side (owner-only fields stay owner-only there).
            if (isOwner || auth.role == 'staff_manager')
              _tile(context, icon: Icons.store_outlined, title: 'Business info',
                  onTap: () => Navigator.push(context, MaterialPageRoute(
                      builder: (_) => const BusinessInfoScreen()))),
            // C2 fix (2026-08-23): route to the backend-connected editor —
            // the legacy MenuScreen saved locally only and edits were
            // silently wiped on the next sync.
            if (can('menu_editor'))
              _tile(context, icon: Icons.restaurant_menu_outlined, title: 'Menu',
                  onTap: () => Navigator.push(context, MaterialPageRoute(
                      builder: (_) => const MenuEditorScreen()))),
            if (can('customers'))
              _tile(context, icon: Icons.favorite_rounded, title: 'Customers',
                  onTap: () => Navigator.push(context, MaterialPageRoute(
                      builder: (_) => const CustomersScreen()))),
            // Floors & tables editing is an owner surface (drawer agrees).
            if (isOwner)
              _tile(context, icon: Icons.grid_view_rounded, title: 'Tables',
                  onTap: () => Navigator.push(context, MaterialPageRoute(
                      builder: (_) => const TablesScreen()))),
            if (can('expenses') || can('expense_register'))
              _tile(context, icon: Icons.savings_outlined, title: 'Expenses',
                  onTap: () => Navigator.push(context, MaterialPageRoute(
                      builder: (_) => const ExpensesScreen()))),
          ]),

          if (can('thermal_printer'))
            _group('Hardware', [
              // "Thermal printer" promises a thermal printer, which an iPhone
              // cannot drive (Apple blocks classic Bluetooth). There the screen
              // is about printing in general — AirPrint / share — so name it
              // for what it does on this device.
              _tile(context, icon: Icons.print_outlined,
                  title: PrinterService.supportsBluetoothPrinting
                      ? 'Thermal printer'
                      : 'Printing',
                  onTap: () => Navigator.push(context, MaterialPageRoute(
                      builder: (_) => const PrinterSetupScreen()))),
            ]),

          // Push 17c — Aggregators row + Auto-WhatsApp toggle only render
          // when the active plan has the matching feature. Owners on
          // Starter no longer see locked rows; if super-admin adds the
          // feature to their tier the row appears on next plan refresh.
          if (auth.has(Features.aggregators) || auth.has(Features.autoWhatsappOrder))
            _group('Integrations', [
              if (auth.has(Features.aggregators) && can('aggregators'))
                _tile(context, icon: Icons.delivery_dining_outlined,
                    title: 'Aggregators (Zomato, Swiggy)',
                    onTap: () => Navigator.push(context, MaterialPageRoute(
                        builder: (_) => const AggregatorsScreen()))),
              if (auth.has(Features.autoWhatsappOrder))
                SwitchListTile(
                  title: const Text('Auto WhatsApp on order ready',
                      style: TextStyle(fontWeight: FontWeight.w600)),
                  subtitle: const Text('Opens WhatsApp with prefilled message',
                      style: TextStyle(fontSize: 12)),
                  value: context.watch<SettingsProvider>().autoWhatsAppOnReady,
                  onChanged: (v) => context.read<SettingsProvider>().toggleAutoWhatsApp(v),
                  activeThumbColor: AppColors.primary,
                ),
              SwitchListTile(
                title: const Text('Low stock alerts',
                    style: TextStyle(fontWeight: FontWeight.w600)),
                value: context.watch<SettingsProvider>().notifyOnLowStock,
                onChanged: (v) => context.read<SettingsProvider>().toggleLowStockAlerts(v),
                activeThumbColor: AppColors.primary,
              ),
            ]),

          // DPDP — every account must reach privacy controls in at most
          // one tap. Cannot be plan-gated.
          _group('Privacy & legal', [
            _tile(context, icon: Icons.shield_outlined, title: 'Privacy & data',
                onTap: () => Navigator.push(context, MaterialPageRoute(
                    builder: (_) => const PrivacyScreen()))),
            _tile(context, icon: Icons.policy_outlined, title: 'Privacy Policy',
                onTap: () => Navigator.push(context, MaterialPageRoute(
                    builder: (_) => const PrivacyPolicyScreen(kind: 'privacy')))),
            _tile(context, icon: Icons.gavel_outlined, title: 'Terms of Service',
                onTap: () => Navigator.push(context, MaterialPageRoute(
                    builder: (_) => const PrivacyPolicyScreen(kind: 'terms')))),
          ]),

          // FF-221 — Help section. Hardcode-audit fix (2026-08-24): the
          // support number comes from AppConfig (--dart-define
          // SUPPORT_WHATSAPP) instead of a personal number in source;
          // the tile is hidden when unset.
          if (AppConfig.hasSupportWhatsApp)
            _group('Help & support', [
              _tile(context, icon: Icons.chat_rounded, title: 'Chat with support on WhatsApp',
                  color: const Color(0xFF25D366),
                  onTap: () async {
                    final uri = Uri.parse(
                      'https://wa.me/${AppConfig.supportWhatsApp}?text=${Uri.encodeComponent("Hi NamastePOS — I need help.")}',
                    );
                    await launchUrl(uri, mode: LaunchMode.externalApplication);
                  }),
            ]),

          _group('Account', [
            _tile(context, icon: Icons.logout_rounded, title: 'Logout',
                color: AppColors.error,
                onTap: () async {
                  await context.read<AuthProvider>().logout();
                  if (context.mounted) Navigator.of(context).popUntil((r) => r.isFirst);
                }),
          ]),
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 30),
            child: Center(
              child: Text('NamastePOS v1.0.0',
                  style: TextStyle(color: AppColors.textHint, fontSize: 12)),
            ),
          ),
        ],
      ),
    );
  }

  Widget _group(String title, List<Widget> children) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 0, 0, 6),
              child: Text(title,
                  style: const TextStyle(
                    color: AppColors.textSecondary,
                    fontWeight: FontWeight.w700,
                    fontSize: 12,
                    letterSpacing: 0.5,
                  )),
            ),
            // Material wrapper required — ListTile draws its background
            // and ink-splash on the nearest Material ancestor. Without
            // one between the Container's decoration and the tiles,
            // Flutter prints a "background color or ink splashes may be
            // invisible" warning for every tile inside.
            // `shape` already encodes the rounded corners — passing
            // both `shape` and `borderRadius` trips a Material assertion.
            Material(
              color: AppColors.surface,
              clipBehavior: Clip.antiAlias,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(14),
                side: const BorderSide(color: AppColors.divider),
              ),
              child: Column(children: children),
            ),
          ],
        ),
      );

  Widget _tile(BuildContext context,
      {required IconData icon, required String title, VoidCallback? onTap, Color? color}) {
    return ListTile(
      onTap: onTap,
      leading: Icon(icon, color: color ?? AppColors.textPrimary),
      title: Text(title, style: TextStyle(color: color ?? AppColors.textPrimary, fontWeight: FontWeight.w600)),
      trailing: const Icon(Icons.chevron_right_rounded, color: AppColors.textHint),
    );
  }

}
