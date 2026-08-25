// NamastePOS - Inventory list (live stock & low-stock alerts)

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../models/inventory_transaction.dart';
import '../../models/menu_item.dart';
import '../../providers/auth_provider.dart';
import '../../providers/inventory_provider.dart';
import '../../providers/menu_provider.dart';
import '../../utils/formatters.dart';
import '../../widgets/empty_state.dart';
import '../menu/menu_editor_screen.dart' show MenuEditorScreen;
import '../../widgets/home_bottom_nav.dart';
import '../../widgets/home_drawer_button.dart';
import 'item_detail_screen.dart';

class InventoryScreen extends StatefulWidget {
  const InventoryScreen({super.key});

  @override
  State<InventoryScreen> createState() => _InventoryScreenState();
}

class _InventoryScreenState extends State<InventoryScreen> {
  bool _showOnlyLow = false;
  String _search = '';

  @override
  Widget build(BuildContext context) {
    final menu = context.watch<MenuProvider>();
    final items = menu.items.where((i) {
      if (_showOnlyLow && !i.isLowStock) return false;
      if (_search.isNotEmpty && !i.name.toLowerCase().contains(_search.toLowerCase())) return false;
      return true;
    }).toList();

    return Scaffold(
      appBar: AppBar(
        leading: (ModalRoute.of(context)?.isFirst ?? true) ? const HomeDrawerButton() : null,
        title: const Text('Inventory'),
        actions: [
          IconButton(
            tooltip: _showOnlyLow ? 'Show all' : 'Show low stock only',
            icon: Icon(_showOnlyLow ? Icons.filter_alt : Icons.filter_alt_outlined,
                color: _showOnlyLow ? AppColors.primary : null),
            onPressed: () => setState(() => _showOnlyLow = !_showOnlyLow),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () => menu.refresh(),
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.all(16),
              child: TextField(
                onChanged: (v) => setState(() => _search = v),
                decoration: InputDecoration(
                  hintText: 'Search items…',
                  prefixIcon: const Icon(Icons.search),
                  isDense: true,
                  fillColor: AppColors.surface,
                  filled: true,
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(12),
                    borderSide: const BorderSide(color: AppColors.divider),
                  ),
                ),
              ),
            ),
            Expanded(
              child: items.isEmpty
                  ? EmptyState(
                      icon: Icons.inventory_2_outlined,
                      title: 'Track stock before you run out',
                      hint: 'Add your ingredients — masalas, oils, dairy — and Adda will deduct them as orders come in. No more "sorry, out of stock" mid-service.',
                      ctaLabel: 'Add first item',
                      onCta: () {
                        // C2 fix: backend-connected editor (see settings).
                        Navigator.of(context).push(MaterialPageRoute(
                          builder: (_) => const MenuEditorScreen(),
                        ));
                      },
                    )
                  : ListView.separated(
                      padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                      itemCount: items.length,
                      separatorBuilder: (_, __) => const SizedBox(height: 10),
                      itemBuilder: (_, i) => _InventoryRow(item: items[i]),
                    ),
            ),
          ],
        ),
      ),
      bottomNavigationBar: const HomeBottomNav(),
    );
  }
}

class _InventoryRow extends StatelessWidget {
  final MenuItem item;
  const _InventoryRow({required this.item});

  Future<void> _adjust(BuildContext context) async {
    final controller = TextEditingController();
    InventoryReason reason = InventoryReason.adjustment;
    final r = await showDialog<double>(
      context: context,
      builder: (ctx) => StatefulBuilder(builder: (ctx, setState) {
        return AlertDialog(
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
          title: Text('Adjust ${item.name}'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: controller,
                keyboardType: const TextInputType.numberWithOptions(decimal: true, signed: true),
                inputFormatters: [
                  FilteringTextInputFormatter.allow(RegExp(r'[-0-9.]')),
                ],
                decoration: const InputDecoration(
                  labelText: 'Quantity change (+/-)',
                  hintText: 'e.g. 10 or -2',
                ),
              ),
              const SizedBox(height: 12),
              DropdownButtonFormField<InventoryReason>(
                menuMaxHeight: 320, isExpanded: true, // scroll long lists (2026-08-25)
                value: reason,
                items: InventoryReason.values.map((r) => DropdownMenuItem(
                  value: r,
                  child: Text(r.name),
                )).toList(),
                onChanged: (v) => setState(() => reason = v ?? InventoryReason.adjustment),
                decoration: const InputDecoration(labelText: 'Reason'),
              ),
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
            ElevatedButton(
              onPressed: () {
                final v = double.tryParse(controller.text.trim());
                Navigator.pop(ctx, v);
              },
              child: const Text('Save'),
            ),
          ],
        );
      }),
    );
    if (r == null || !context.mounted) return;
    final biz = context.read<AuthProvider>().business;
    if (biz == null) return;
    await context.read<InventoryProvider>().adjust(
          businessId: biz.id,
          menuItemId: item.id,
          delta: r,
          reason: reason,
        );
    if (context.mounted) {
      context.read<MenuProvider>().updateLocalStock(item.id, item.stock + r);
    }
  }

  @override
  Widget build(BuildContext context) {
    final low = item.isLowStock;
    return InkWell(
      borderRadius: BorderRadius.circular(12),
      onTap: () => Navigator.push(context, MaterialPageRoute(
          builder: (_) => ItemDetailScreen(itemId: item.id))),
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: low ? AppColors.warning : AppColors.divider),
        ),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Container(
                        width: 10, height: 10,
                        decoration: BoxDecoration(
                          color: item.isVeg ? AppColors.success : AppColors.error,
                          shape: BoxShape.circle,
                        ),
                      ),
                      const SizedBox(width: 6),
                      Expanded(
                        child: Text(item.name,
                            style: const TextStyle(fontWeight: FontWeight.w700)),
                      ),
                      if (low)
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                          decoration: BoxDecoration(
                            color: AppColors.warning.withValues(alpha: 0.18),
                            borderRadius: BorderRadius.circular(6),
                          ),
                          child: const Text('LOW',
                              style: TextStyle(
                                color: AppColors.warning,
                                fontWeight: FontWeight.w700,
                                fontSize: 10,
                              )),
                        ),
                    ],
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'Stock: ${AppFmt.quantity(item.stock)} ${item.unit.short} · reorder at ${AppFmt.quantity(item.reorderLevel)}',
                    style: const TextStyle(color: AppColors.textSecondary, fontSize: 12),
                  ),
                ],
              ),
            ),
            IconButton(
              onPressed: () => _adjust(context),
              icon: const Icon(Icons.tune_rounded),
              color: AppColors.primary,
            ),
          ],
        ),
      ),
    );
  }
}
