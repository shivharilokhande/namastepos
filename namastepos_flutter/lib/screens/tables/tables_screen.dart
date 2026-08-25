// NamastePOS - Live table grid (floor plan) for the cashier

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../../utils/formatters.dart';
import '../../widgets/home_bottom_nav.dart';
import '../../widgets/home_drawer_button.dart';

class TablesScreen extends StatefulWidget {
  const TablesScreen({super.key});

  @override
  State<TablesScreen> createState() => _TablesScreenState();
}

class _TablesScreenState extends State<TablesScreen> {
  List<dynamic> _floors = [];
  List<dynamic> _tables = [];
  String? _selectedFloorId;
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final biz = context.read<AuthProvider>().business;
    if (biz == null) return;
    setState(() { _loading = true; _error = null; });
    try {
      final floors = await ApiService.instance.listFloors(biz.id);
      final tables = await ApiService.instance.listOpsTables(biz.id);
      if (!mounted) return; // H6 (2026-08-23)
      setState(() {
        _floors = floors;
        _tables = tables;
        _selectedFloorId ??= floors.isNotEmpty ? floors.first['id'] as String : null;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() { _error = e.toString(); _loading = false; });
    }
  }

  Color _statusBg(String status) {
    switch (status) {
      case 'available': return Colors.green.shade100;
      case 'occupied': return Colors.amber.shade100;
      case 'reserved': return Colors.blue.shade100;
      case 'cleaning': return Colors.grey.shade200;
      case 'blocked':  return Colors.red.shade100;
    }
    return Colors.grey.shade100;
  }
  Color _statusFg(String status) {
    switch (status) {
      case 'available': return Colors.green.shade800;
      case 'occupied': return Colors.amber.shade900;
      case 'reserved': return Colors.blue.shade800;
      case 'cleaning': return Colors.grey.shade700;
      case 'blocked':  return Colors.red.shade800;
    }
    return Colors.grey.shade700;
  }

  @override
  Widget build(BuildContext context) {
    final filtered = _selectedFloorId == null
        ? _tables
        : _tables.where((t) => t['floorId'] == _selectedFloorId).toList();

    return Scaffold(
      appBar: AppBar(
        leading: (ModalRoute.of(context)?.isFirst ?? true) ? const HomeDrawerButton() : null,
        title: const Text('Tables'),
        actions: [
          IconButton(icon: const Icon(Icons.refresh_rounded), onPressed: _load),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Text(_error!, style: const TextStyle(color: AppColors.error)))
              : Column(
                  children: [
                    if (_floors.isNotEmpty)
                      SizedBox(
                        height: 56,
                        child: ListView.separated(
                          padding: const EdgeInsets.all(12),
                          scrollDirection: Axis.horizontal,
                          itemCount: _floors.length,
                          separatorBuilder: (_, __) => const SizedBox(width: 8),
                          itemBuilder: (_, i) {
                            final f = _floors[i];
                            final selected = f['id'] == _selectedFloorId;
                            return ChoiceChip(
                              label: Text(f['name']),
                              selected: selected,
                              onSelected: (_) => setState(() => _selectedFloorId = f['id']),
                              selectedColor: AppColors.primary,
                              labelStyle: TextStyle(
                                color: selected ? Colors.white : AppColors.textPrimary,
                                fontWeight: FontWeight.w600,
                              ),
                            );
                          },
                        ),
                      ),
                    if (_floors.isEmpty)
                      const Padding(
                        padding: EdgeInsets.all(24),
                        child: Text('No floors configured. Set them up from the web dashboard.',
                            textAlign: TextAlign.center,
                            style: TextStyle(color: AppColors.textSecondary)),
                      ),
                    Expanded(
                      child: GridView.builder(
                        padding: const EdgeInsets.all(16),
                        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                          crossAxisCount: 3,
                          childAspectRatio: 1,
                          crossAxisSpacing: 12,
                          mainAxisSpacing: 12,
                        ),
                        itemCount: filtered.length,
                        itemBuilder: (_, i) {
                          final t = filtered[i];
                          final status = t['status'] as String? ?? 'available';
                          final total = t['sessionTotalInr'];
                          // Joined-group marker (2026-08-25, F2): the primary
                          // carries sessionJoinedTableIds, each secondary is
                          // isJoinedSecondary — all share ONE session/bill,
                          // so the link badge flags "same party" to staff.
                          final joined = t['isJoinedSecondary'] == true ||
                              ((t['sessionJoinedTableIds'] as List?)
                                      ?.isNotEmpty ??
                                  false);
                          return InkWell(
                            onTap: () => Navigator.pop(context, t),
                            borderRadius: BorderRadius.circular(12),
                            child: Container(
                              decoration: BoxDecoration(
                                color: _statusBg(status),
                                borderRadius: BorderRadius.circular(12),
                                border: Border.all(color: _statusFg(status).withValues(alpha: 0.4), width: 2),
                              ),
                              padding: const EdgeInsets.all(8),
                              // Stack (2026-08-25, F2): corner link badge for
                              // joined tables without moving the centered text.
                              child: Stack(
                                alignment: Alignment.center,
                                children: [
                                  if (joined)
                                    Positioned(
                                      top: 0,
                                      right: 0,
                                      child: Icon(Icons.link,
                                          size: 14, color: _statusFg(status)),
                                    ),
                                  Column(
                                mainAxisAlignment: MainAxisAlignment.center,
                                children: [
                                  Text(t['label'] ?? '?',
                                      style: TextStyle(
                                        fontSize: 28, fontWeight: FontWeight.w800,
                                        color: _statusFg(status),
                                      )),
                                  const SizedBox(height: 4),
                                  Row(
                                    mainAxisAlignment: MainAxisAlignment.center,
                                    children: [
                                      Icon(Icons.person_outline, size: 12, color: _statusFg(status)),
                                      const SizedBox(width: 2),
                                      Text('${t['seats']}',
                                          style: TextStyle(fontSize: 11, color: _statusFg(status))),
                                    ],
                                  ),
                                  Text(status.toUpperCase(),
                                      style: TextStyle(
                                        fontSize: 9, fontWeight: FontWeight.w700,
                                        color: _statusFg(status),
                                      )),
                                  if (total != null)
                                    Text(AppFmt.money((total as num).toDouble()),
                                        style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700,
                                            color: _statusFg(status))),
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
