// NamastePOS - Customer database (CRM) - gated behind 'loyalty' addon

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../constants/feature_keys.dart';
import '../../models/customer.dart';
import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../../utils/formatters.dart';
import '../../widgets/empty_state.dart';
import '../../widgets/home_bottom_nav.dart';
import '../../widgets/home_drawer_button.dart';
import 'customer_detail_screen.dart';

class CustomersScreen extends StatefulWidget {
  const CustomersScreen({super.key});

  @override
  State<CustomersScreen> createState() => _CustomersScreenState();
}

class _CustomersScreenState extends State<CustomersScreen> {
  List<Customer> _customers = [];
  bool _loading = false;
  String _search = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    // Push 17d — gate on the plan's customers_basic feature instead of
    // the loyalty addon. Marketplace browse is no longer required —
    // customer database comes free with every plan that includes
    // customers_basic (which is the Starter tier and up).
    final hasCustomers = context.read<AuthProvider>().has(Features.customersBasic);
    if (!hasCustomers) return;
    final biz = context.read<AuthProvider>().business;
    if (biz == null) return;

    setState(() => _loading = true);
    try {
      final list = await ApiService.instance.listCustomers(
        biz.id, search: _search.isEmpty ? null : _search,
      );
      if (!mounted) return; // P2 fix (2026-08-22)
      setState(() {
        _customers = list
            .map((c) => Customer.fromMap(c as Map<String, dynamic>))
            .toList();
        _loading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    // Push 17d — gate on plan feature, not addon.
    final hasCustomers = context.watch<AuthProvider>().has(Features.customersBasic);
    if (!hasCustomers) {
      return Scaffold(
        appBar: AppBar(
        leading: (ModalRoute.of(context)?.isFirst ?? true) ? const HomeDrawerButton() : null,
        title: const Text('Customers')),
        body: const Center(
          child: Padding(
            padding: EdgeInsets.all(32),
            child: Text(
              'Customer database is not included in your plan. '
              'Upgrade to capture phone numbers, give loyalty points, '
              'and send birthday rewards.',
              textAlign: TextAlign.center,
            ),
          ),
        ),
      bottomNavigationBar: const HomeBottomNav(),
      );
    }
    return Scaffold(
      appBar: AppBar(
        leading: (ModalRoute.of(context)?.isFirst ?? true) ? const HomeDrawerButton() : null,
        title: const Text('Customers')),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: TextField(
              decoration: const InputDecoration(
                hintText: 'Search name, phone, email…',
                prefixIcon: Icon(Icons.search_rounded),
              ),
              onChanged: (v) {
                _search = v;
                _load();
              },
            ),
          ),
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : _customers.isEmpty
                    ? EmptyState(
                        icon: Icons.people_outline,
                        title: 'Your regulars start here',
                        hint: 'Save a phone number the next time someone orders — we track their favourites, birthdays and orders so you can win them back on a slow Tuesday.',
                        ctaLabel: 'Take a new order',
                        onCta: () {
                          Navigator.of(context).popUntil((r) => r.isFirst);
                        },
                      )
                    : ListView.separated(
                        padding: const EdgeInsets.all(16),
                        itemCount: _customers.length,
                        separatorBuilder: (_, __) => const SizedBox(height: 8),
                        itemBuilder: (_, i) {
                          final c = _customers[i];
                          // Tappable (2026-08-22): opens order history +
                          // membership screen.
                          return InkWell(
                            borderRadius: BorderRadius.circular(12),
                            onTap: () => Navigator.of(context).push(
                              MaterialPageRoute(
                                builder: (_) =>
                                    CustomerDetailScreen(customer: c),
                              ),
                            ).then((_) => _load()),
                            child: Container(
                            padding: const EdgeInsets.all(12),
                            decoration: BoxDecoration(
                              color: AppColors.surface,
                              borderRadius: BorderRadius.circular(12),
                              border: Border.all(color: AppColors.divider),
                            ),
                            child: Row(
                              children: [
                                Container(
                                  width: 44, height: 44,
                                  decoration: BoxDecoration(
                                    color: AppColors.primary.withValues(alpha: 0.10),
                                    borderRadius: BorderRadius.circular(22),
                                  ),
                                  child: const Icon(Icons.person_rounded, color: AppColors.primary),
                                ),
                                const SizedBox(width: 12),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Text(c.name?.isNotEmpty == true ? c.name! : c.phone,
                                          style: const TextStyle(fontWeight: FontWeight.w700)),
                                      Text('${c.phone} · ${c.visitCount} visits · ${c.tier}',
                                          style: const TextStyle(
                                            color: AppColors.textSecondary, fontSize: 12,
                                          )),
                                    ],
                                  ),
                                ),
                                Column(
                                  crossAxisAlignment: CrossAxisAlignment.end,
                                  children: [
                                    Text('${c.pointsBalance} pts',
                                        style: const TextStyle(
                                          fontWeight: FontWeight.w700,
                                          color: AppColors.primary,
                                        )),
                                    Text(AppFmt.money(c.totalSpent),
                                        style: const TextStyle(fontSize: 12, color: AppColors.textSecondary)),
                                  ],
                                ),
                              ],
                            ),
                            ),
                          );
                        },
                      ),
          ),
        ],
      ),
      bottomNavigationBar: const HomeBottomNav(),
    );
  }
}
