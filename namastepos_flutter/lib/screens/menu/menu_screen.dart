// NamastePOS - Menu CRUD list

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:flutter_slidable/flutter_slidable.dart';

import '../../constants/colors.dart';
import '../../providers/menu_provider.dart';
import '../../utils/formatters.dart';
import '../../widgets/home_bottom_nav.dart';
import '../../widgets/home_drawer_button.dart';
import 'edit_item_screen.dart';

class MenuScreen extends StatelessWidget {
  const MenuScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final menu = context.watch<MenuProvider>();
    return Scaffold(
      appBar: AppBar(
        leading: (ModalRoute.of(context)?.isFirst ?? true) ? const HomeDrawerButton() : null,
        title: const Text('Menu'),
      ),
      bottomNavigationBar: const HomeBottomNav(),
      floatingActionButton: FloatingActionButton.extended(
        backgroundColor: AppColors.primary,
        foregroundColor: Colors.white,
        icon: const Icon(Icons.add),
        label: const Text('Add item'),
        onPressed: () => Navigator.push(context, MaterialPageRoute(
            builder: (_) => const EditItemScreen())),
      ),
      body: RefreshIndicator(
        onRefresh: () => menu.refresh(),
        child: ListView.separated(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 100),
          itemCount: menu.items.length,
          separatorBuilder: (_, __) => const SizedBox(height: 10),
          itemBuilder: (_, i) {
            final it = menu.items[i];
            return Slidable(
              endActionPane: ActionPane(
                motion: const ScrollMotion(),
                children: [
                  SlidableAction(
                    onPressed: (_) => Navigator.push(context, MaterialPageRoute(
                        builder: (_) => EditItemScreen(item: it))),
                    icon: Icons.edit_outlined,
                    label: 'Edit',
                    backgroundColor: AppColors.info,
                    foregroundColor: Colors.white,
                  ),
                  SlidableAction(
                    onPressed: (_) async {
                      final r = await showDialog<bool>(
                        context: context,
                        builder: (_) => AlertDialog(
                          title: const Text('Remove item?'),
                          content: Text('"${it.name}" will be hidden from the menu.'),
                          actions: [
                            TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
                            TextButton(onPressed: () => Navigator.pop(context, true), child: const Text('Remove')),
                          ],
                        ),
                      );
                      if (r == true && context.mounted) {
                        await context.read<MenuProvider>().remove(it);
                      }
                    },
                    icon: Icons.delete_outline,
                    label: 'Delete',
                    backgroundColor: AppColors.error,
                    foregroundColor: Colors.white,
                  ),
                ],
              ),
              child: InkWell(
                borderRadius: BorderRadius.circular(12),
                onTap: () => Navigator.push(context, MaterialPageRoute(
                    builder: (_) => EditItemScreen(item: it))),
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
                          color: AppColors.primary.withValues(alpha: 0.08),
                          borderRadius: BorderRadius.circular(10),
                        ),
                        child: const Icon(Icons.fastfood_outlined, color: AppColors.primary),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(it.name, style: const TextStyle(fontWeight: FontWeight.w700)),
                            Text('${it.category} · ${it.isVeg ? "Veg" : "Non-veg"}',
                                style: const TextStyle(color: AppColors.textSecondary, fontSize: 12)),
                          ],
                        ),
                      ),
                      Text(AppFmt.money(it.price),
                          style: const TextStyle(fontWeight: FontWeight.w700, color: AppColors.primary)),
                    ],
                  ),
                ),
              ),
            );
          },
        ),
      ),
    );
  }
}
