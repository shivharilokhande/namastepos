// NamastePOS — Customer detail (2026-08-22, founder request).
//
// Tapping a customer in the CRM list opens this screen: profile stats,
// points, order history, favourite items, and membership — with an
// "Add membership" flow (pick a plan → payment method → subscribed).
// Data comes from GET /businesses/:id/customer-history/:phone.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../models/customer.dart';
import '../../providers/auth_provider.dart';
import '../../providers/menu_provider.dart';
import '../../services/api_service.dart';
import '../../utils/error_humanizer.dart';
import '../../utils/formatters.dart';
import '../orders/order_detail_screen.dart';
import '../../widgets/membership_plan_dialog.dart';

class CustomerDetailScreen extends StatefulWidget {
  final Customer customer;
  const CustomerDetailScreen({super.key, required this.customer});

  @override
  State<CustomerDetailScreen> createState() => _CustomerDetailScreenState();
}

class _CustomerDetailScreenState extends State<CustomerDetailScreen> {
  Map<String, dynamic>? _profile;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final biz = context.read<AuthProvider>().business;
    if (biz == null) {
      setState(() => _loading = false);
      return;
    }
    try {
      final r = await ApiService.instance.dio.get(
        '/businesses/${biz.id}/customer-history/${widget.customer.phone}',
      );
      if (!mounted) return;
      setState(() {
        _profile = (r.data as Map).cast<String, dynamic>();
        _loading = false;
      });
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _addMembership() async {
    final biz = context.read<AuthProvider>().business;
    if (biz == null) return;
    final messenger = ScaffoldMessenger.of(context);
    List<dynamic> plans = [];
    try {
      final r = await ApiService.instance.dio
          .get('/businesses/${biz.id}/memberships');
      plans = (r.data['memberships'] as List?) ?? [];
    } catch (e) {
      messenger.showSnackBar(
          SnackBar(content: Text(humanizeError(e))));
      return;
    }
    if (!mounted) return;
    if (plans.isEmpty) {
      messenger.showSnackBar(const SnackBar(
        content: Text('No membership plans yet — create one below.'),
      ));
      await _createMembershipPlan();
      return;
    }
    final picked = await showModalBottomSheet<Map<String, dynamic>?>(
      context: context,
      showDragHandle: true,
      builder: (sheetCtx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Padding(
              padding: EdgeInsets.all(16),
              child: Text('Pick a membership plan',
                  style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
            ),
            for (final p in plans)
              ListTile(
                leading: const Icon(Icons.card_membership,
                    color: AppColors.primary),
                title: Text((p as Map)['name']?.toString() ?? 'Plan'),
                subtitle: Text(
                    '${AppFmt.moneyPaise((p['price_paise'] ?? 0) as num)} · '
                    '${p['validity_days'] ?? 30} days'),
                onTap: () => Navigator.pop(
                    sheetCtx, p.cast<String, dynamic>()),
              ),
            // 2026-08-23: creating a bundled plan was only reachable
            // when NO plans existed — now always available here.
            ListTile(
              leading: const Icon(Icons.add_circle_outline,
                  color: AppColors.textSecondary),
              title: const Text('Create new plan…'),
              onTap: () =>
                  Navigator.pop(sheetCtx, {'__create__': true}),
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
    if (picked == null || !mounted) return;
    if (picked['__create__'] == true) {
      final created = await showCreateMembershipPlanDialog(context);
      if (created && mounted) await _addMembership(); // reopen picker
      return;
    }
    try {
      await ApiService.instance.dio.post(
        '/businesses/${biz.id}/memberships/subscribe',
        data: {
          'customerId': widget.customer.id,
          'membershipId': picked['id'],
          'paymentMethod': 'cash',
        },
      );
      messenger.showSnackBar(SnackBar(
        content: Text('${widget.customer.name ?? widget.customer.phone} '
            'enrolled in ${picked['name']} ✓'),
        backgroundColor: AppColors.success,
      ));
      await _load();
    } catch (e) {
      messenger.showSnackBar(SnackBar(
          content: Text(humanizeError(e)),
          backgroundColor: AppColors.error));
    }
  }

  /// Owner-only quick create — shared dialog (bundle items + price +
  /// validity). See widgets/membership_plan_dialog.dart.
  Future<void> _createMembershipPlan() async {
    await showCreateMembershipPlanDialog(context);
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.customer;
    final prof =
        (_profile?['customer'] as Map?)?.cast<String, dynamic>();
    final recent = (_profile?['recentOrders'] as List?) ?? [];
    final favourites = (_profile?['favourites'] as List?) ?? [];
    final activeMembership =
        (_profile?['activeMembership'] as Map?)?.cast<String, dynamic>();

    return Scaffold(
      appBar: AppBar(
          title: Text(c.name?.isNotEmpty == true ? c.name! : c.phone)),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  // Stats card
                  Container(
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      color: AppColors.primary.withValues(alpha: 0.08),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.spaceAround,
                      children: [
                        _stat('${prof?['pointsBalance'] ?? c.pointsBalance}',
                            'Points'),
                        _stat('${prof?['totalOrders'] ?? c.visitCount}',
                            'Orders'),
                        _stat(
                            AppFmt.money((prof?['totalSpent'] as num?)
                                    ?.toDouble() ??
                                c.totalSpent),
                            'Spent'),
                        _stat((prof?['tier'] ?? c.tier).toString(), 'Tier'),
                      ],
                    ),
                  ),
                  const SizedBox(height: 16),
                  // Membership
                  _sectionTitle('Membership'),
                  if (activeMembership != null) ...[
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: const Icon(Icons.card_membership,
                          color: AppColors.success),
                      title: Text(
                          activeMembership['name']?.toString() ?? 'Member'),
                      subtitle: Text(
                          'Valid till ${(activeMembership['expires_at'] ?? '').toString().split('T').first}'),
                    ),
                    // Remaining bundle balance (2026-08-23): "12× Cold
                    // Coffee left" chips, counted down on every order.
                    if (activeMembership['remaining'] is List &&
                        (activeMembership['remaining'] as List).isNotEmpty)
                      Wrap(
                        spacing: 8,
                        runSpacing: 4,
                        children: [
                          for (final e
                              in (activeMembership['remaining'] as List))
                            Chip(
                              visualDensity: VisualDensity.compact,
                              label: Text(
                                '${(e as Map)['qty']}× ${_menuName(e['menuItemId']?.toString())} left',
                                style: const TextStyle(fontSize: 12),
                              ),
                            ),
                        ],
                      ),
                  ] else
                    OutlinedButton.icon(
                      icon: const Icon(Icons.card_membership, size: 18),
                      label: const Text('Add membership'),
                      onPressed: _addMembership,
                    ),
                  const SizedBox(height: 16),
                  // Order history
                  _sectionTitle('Order history'),
                  if (recent.isEmpty)
                    const Padding(
                      padding: EdgeInsets.symmetric(vertical: 8),
                      child: Text('No orders yet.',
                          style:
                              TextStyle(color: AppColors.textSecondary)),
                    )
                  else
                    ...recent.map((o) {
                      final m = (o as Map).cast<String, dynamic>();
                      final when = DateTime.tryParse(
                          (m['created_at'] ?? '').toString());
                      return ListTile(
                        contentPadding: EdgeInsets.zero,
                        dense: true,
                        // Tap → full order invoice (2026-08-23)
                        onTap: () => Navigator.of(context).push(
                          MaterialPageRoute(
                            builder: (_) =>
                                OrderDetailScreen(orderId: m['id'] as String),
                          ),
                        ),
                        leading: const Icon(Icons.receipt_long_outlined),
                        title: Text('Order #${m['order_no']}',
                            style: const TextStyle(
                                fontWeight: FontWeight.w700)),
                        subtitle: Text(when != null
                            ? '${AppFmt.date(when)} · ${m['status']}'
                            : '${m['status']}'),
                        trailing: Text(
                            AppFmt.money(double.tryParse(
                                    m['total'].toString()) ??
                                0),
                            style: const TextStyle(
                                fontWeight: FontWeight.w800)),
                      );
                    }),
                  const SizedBox(height: 16),
                  // Favourites
                  if (favourites.isNotEmpty) ...[
                    _sectionTitle('Usually orders'),
                    Wrap(
                      spacing: 8,
                      runSpacing: 4,
                      children: [
                        for (final f in favourites)
                          Chip(
                            label: Text(
                                '${(f as Map)['name']} ×${f['qty_total']}'),
                            labelStyle: const TextStyle(fontSize: 12),
                          ),
                      ],
                    ),
                  ],
                ],
              ),
            ),
    );
  }

  String _menuName(String? menuItemId) {
    if (menuItemId == null) return 'item';
    final matches = context
        .read<MenuProvider>()
        .visibleItems
        .where((m) => m.id == menuItemId);
    return matches.isEmpty ? 'item' : matches.first.name;
  }

  Widget _sectionTitle(String t) => Padding(
        padding: const EdgeInsets.only(bottom: 6),
        child: Text(t,
            style: const TextStyle(
                fontWeight: FontWeight.w800, fontSize: 15)),
      );

  Widget _stat(String v, String label) => Column(
        children: [
          Text(v,
              style: const TextStyle(
                  fontSize: 16, fontWeight: FontWeight.w900)),
          Text(label,
              style: const TextStyle(
                  fontSize: 11, color: AppColors.textSecondary)),
        ],
      );
}
