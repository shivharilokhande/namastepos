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
import '../../services/api_service.dart';
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

  // NP-205 (migration 084) — each variant owns its stock, so each size needs
  // its own row and its own adjust control. Fetched straight from
  // `GET /menu?withVariants=true` rather than through MenuProvider: the local
  // sqflite cache has no variant schema, and one request beats N.
  // menuItemId → [{id, label, price, stock, trackStock, isActive}, …]
  Map<String, List<dynamic>> _variantsByItem = {};
  bool _variantsLoading = false;

  @override
  void initState() {
    super.initState();
    // Post-frame: needs AuthProvider, and initState runs before the first
    // build has a context we can read providers from safely.
    WidgetsBinding.instance.addPostFrameCallback((_) => _loadVariants());
  }

  Future<void> _loadVariants() async {
    if (!mounted) return;
    final biz = context.read<AuthProvider>().business;
    if (biz == null) return;
    setState(() => _variantsLoading = true);
    try {
      final map = await ApiService.instance.listMenuVariantsByItem(biz.id);
      if (mounted) setState(() => _variantsByItem = map);
    } catch (_) {
      // Non-fatal: the screen still works item-by-item. A Starter plan 402s
      // the variants feature entirely, and offline there is nothing to show.
      if (mounted) setState(() => _variantsByItem = {});
    } finally {
      if (mounted) setState(() => _variantsLoading = false);
    }
  }

  /// Rows to render: each matching item, then its ACTIVE variants directly
  /// under it. A dish is kept when the dish OR one of its sizes matches, so
  /// "show low stock only" surfaces a dish whose Large is nearly out even
  /// though the dish itself isn't tracked.
  List<_Row> _rows(List<MenuItem> items) {
    final q = _search.trim().toLowerCase();
    final out = <_Row>[];
    for (final i in items) {
      if (q.isNotEmpty && !i.name.toLowerCase().contains(q)) continue;
      final variants = (_variantsByItem[i.id] ?? const [])
          .where((v) => (v as Map)['isActive'] != false)
          .toList();
      final lowVariants = variants.where((v) => _variantLow(i, v as Map)).toList();
      if (_showOnlyLow && !i.isLowStock && lowVariants.isEmpty) continue;
      out.add(_Row.item(i));
      for (final v in (_showOnlyLow && !i.isLowStock ? lowVariants : variants)) {
        out.add(_Row.variant(i, v as Map));
      }
    }
    return out;
  }

  // Variants have no reorder_level column of their own — they inherit the
  // dish's threshold rather than making the owner maintain a second number.
  static bool _variantLow(MenuItem parent, Map v) {
    if (v['trackStock'] != true) return false;
    return ((v['stock'] as num?)?.toDouble() ?? 0) <= parent.reorderLevel;
  }

  @override
  Widget build(BuildContext context) {
    final menu = context.watch<MenuProvider>();
    final rows = _rows(menu.items);

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
        onRefresh: () async {
          // Pull-to-refresh has to refresh BOTH halves now: the dish rows
          // come from MenuProvider, the size rows from the variants fetch.
          await Future.wait([menu.refresh(), _loadVariants()]);
        },
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
            if (_variantsLoading)
              const LinearProgressIndicator(minHeight: 2),
            Expanded(
              child: rows.isEmpty
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
                      itemCount: rows.length,
                      // Variant rows hug the dish above them; dishes get air.
                      separatorBuilder: (_, i) => SizedBox(
                          height: rows[i + 1].variant == null ? 10 : 4),
                      itemBuilder: (_, i) {
                        final r = rows[i];
                        return r.variant == null
                            ? _InventoryRow(item: r.item)
                            : _VariantInventoryRow(
                                parent: r.item,
                                variant: r.variant!,
                                onChanged: _loadVariants,
                              );
                      },
                    ),
            ),
          ],
        ),
      ),
      bottomNavigationBar: const HomeBottomNav(),
    );
  }
}

/// One line in the list: a dish, or one of its sizes. `variant == null` means
/// the dish itself. (NP-205 — a variant is a stock row in its own right now.)
class _Row {
  final MenuItem item;
  final Map? variant;
  const _Row.item(this.item) : variant = null;
  const _Row.variant(this.item, this.variant);
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
                      // NP-205: "out" is the harder subset of low and only
                      // means anything on a tracked item.
                      if (item.isOutOfStock)
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                          decoration: BoxDecoration(
                            color: AppColors.error.withValues(alpha: 0.18),
                            borderRadius: BorderRadius.circular(6),
                          ),
                          child: const Text('OUT',
                              style: TextStyle(
                                color: AppColors.error,
                                fontWeight: FontWeight.w700,
                                fontSize: 10,
                              )),
                        )
                      else if (low)
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
                    // NP-205: an untracked item is unlimited, so quoting a
                    // number here (always 0) was actively misleading — it
                    // read as "out of stock" on dishes that never run out.
                    item.trackStock
                        ? 'Stock: ${AppFmt.quantity(item.stock)} ${item.unit.short} · reorder at ${AppFmt.quantity(item.reorderLevel)}'
                        : 'Stock not tracked · unlimited',
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

/// NP-205 (migration 084) — one VARIANT's stock, indented under its dish.
///
/// Variants have owned a `stock` column since migration 013, but nothing ever
/// deducted it: selling a Large moved the dish's shared pool, so this number
/// was decoration. Now the order path deducts the exact row a line came out
/// of, which makes it worth setting — and this row is where the owner sets it
/// (through the variant twin of the item stock endpoint, so a delivery of
/// Large doesn't have to go through the replace-all variant list).
class _VariantInventoryRow extends StatelessWidget {
  final MenuItem parent;
  final Map variant;
  final Future<void> Function() onChanged;
  const _VariantInventoryRow({
    required this.parent,
    required this.variant,
    required this.onChanged,
  });

  bool get _tracked => variant['trackStock'] == true;
  double get _stock => (variant['stock'] as num?)?.toDouble() ?? 0;
  bool get _low => _tracked && _stock <= parent.reorderLevel;
  bool get _out => _tracked && _stock <= 0;
  String get _label => variant['label']?.toString() ?? '?';

  Future<void> _adjust(BuildContext context) async {
    final controller = TextEditingController();
    InventoryReason reason = InventoryReason.adjustment;
    final r = await showDialog<double>(
      context: context,
      builder: (ctx) => StatefulBuilder(builder: (ctx, setState) {
        return AlertDialog(
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
          title: Text('Adjust ${parent.name} · $_label'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (!_tracked)
                const Padding(
                  padding: EdgeInsets.only(bottom: 8),
                  child: Text(
                    'This size isn’t counted yet. Saving starts counting '
                    'it — after that, sales reduce it and 0 stops the sale.',
                    style: TextStyle(fontSize: 11, color: AppColors.warning),
                  ),
                ),
              TextField(
                controller: controller,
                keyboardType: const TextInputType.numberWithOptions(
                    decimal: true, signed: true),
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
                menuMaxHeight: 320, isExpanded: true,
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
    try {
      await ApiService.instance.adjustVariantStock(
        businessId: biz.id,
        menuItemId: parent.id,
        variantId: variant['id'] as String,
        delta: r,
        reason: reason.name,
      );
      // Re-read from the server rather than patching the map locally: the
      // response is authoritative and a stale local number here is exactly
      // the class of bug this whole change exists to remove.
      await onChanged();
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Could not update $_label: $e')),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final border = _out
        ? AppColors.error
        : _low ? AppColors.warning : AppColors.divider;
    return Padding(
      // Indented so it reads as belonging to the dish above it.
      padding: const EdgeInsets.only(left: 20),
      child: Container(
        padding: const EdgeInsets.fromLTRB(12, 10, 4, 10),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: border),
        ),
        child: Row(
          children: [
            const Icon(Icons.subdirectory_arrow_right,
                size: 16, color: AppColors.textHint),
            const SizedBox(width: 6),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(_label,
                            style: const TextStyle(
                                fontWeight: FontWeight.w600, fontSize: 13)),
                      ),
                      if (_out)
                        _pill('SOLD OUT', AppColors.error)
                      else if (_low)
                        _pill('LOW', AppColors.warning),
                    ],
                  ),
                  const SizedBox(height: 2),
                  Text(
                    _tracked
                        ? 'Stock: ${AppFmt.quantity(_stock)} ${parent.unit.short}'
                        : 'Not tracked · unlimited',
                    style: const TextStyle(
                        color: AppColors.textSecondary, fontSize: 11),
                  ),
                ],
              ),
            ),
            IconButton(
              onPressed: () => _adjust(context),
              icon: const Icon(Icons.tune_rounded, size: 20),
              color: AppColors.primary,
            ),
          ],
        ),
      ),
    );
  }

  Widget _pill(String text, Color color) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.18),
          borderRadius: BorderRadius.circular(6),
        ),
        child: Text(text,
            style: TextStyle(
              color: color,
              fontWeight: FontWeight.w700,
              fontSize: 10,
            )),
      );
}
