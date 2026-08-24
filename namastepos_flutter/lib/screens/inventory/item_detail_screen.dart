// NamastePOS - Inventory item detail (stock movements log)

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../models/inventory_transaction.dart';
import '../../models/menu_item.dart';  // for MenuUnitX.short extension
import '../../providers/inventory_provider.dart';
import '../../providers/menu_provider.dart';
import '../../utils/formatters.dart';

class ItemDetailScreen extends StatelessWidget {
  final String itemId;
  const ItemDetailScreen({super.key, required this.itemId});

  @override
  Widget build(BuildContext context) {
    final item = context.watch<MenuProvider>().byId(itemId);
    if (item == null) {
      return const Scaffold(body: Center(child: Text('Item not found')));
    }
    return Scaffold(
      appBar: AppBar(title: Text(item.name)),
      body: FutureBuilder<List<InventoryTransaction>>(
        future: context.read<InventoryProvider>().history(itemId),
        builder: (context, snap) {
          if (snap.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }
          final history = snap.data ?? const [];
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: AppColors.surface,
                  borderRadius: BorderRadius.circular(14),
                  border: Border.all(color: AppColors.divider),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(item.name, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
                    const SizedBox(height: 4),
                    Text('Category · ${item.category}',
                        style: const TextStyle(color: AppColors.textSecondary)),
                    const Divider(height: 24),
                    Row(
                      children: [
                        _stat('Stock', '${AppFmt.quantity(item.stock)} ${item.unit.short}'),
                        _stat('Reorder', AppFmt.quantity(item.reorderLevel)),
                        _stat('Price', AppFmt.money(item.price)),
                        _stat('Margin', '${item.marginPct.toStringAsFixed(0)}%'),
                      ],
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 16),
              const Text('Stock movements',
                  style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
              const SizedBox(height: 8),
              if (history.isEmpty)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 24),
                  child: Center(child: Text('No movements yet.',
                      style: TextStyle(color: AppColors.textSecondary))),
                )
              else
                ...history.map((t) => Container(
                  margin: const EdgeInsets.only(bottom: 8),
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: AppColors.surface,
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(color: AppColors.divider),
                  ),
                  child: Row(
                    children: [
                      Icon(
                        t.qtyChange >= 0 ? Icons.arrow_upward_rounded : Icons.arrow_downward_rounded,
                        color: t.qtyChange >= 0 ? AppColors.success : AppColors.error,
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text('${t.qtyChange >= 0 ? '+' : ''}${AppFmt.quantity(t.qtyChange)}  ·  ${t.reason.name}',
                                style: const TextStyle(fontWeight: FontWeight.w700)),
                            Text(AppFmt.dateTime(t.createdAt),
                                style: const TextStyle(color: AppColors.textSecondary, fontSize: 12)),
                          ],
                        ),
                      ),
                      Text('= ${AppFmt.quantity(t.balanceAfter)}',
                          style: const TextStyle(color: AppColors.textSecondary)),
                    ],
                  ),
                )),
            ],
          );
        },
      ),
    );
  }

  Widget _stat(String label, String value) => Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label, style: const TextStyle(color: AppColors.textSecondary, fontSize: 12)),
            Text(value, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
          ],
        ),
      );
}
