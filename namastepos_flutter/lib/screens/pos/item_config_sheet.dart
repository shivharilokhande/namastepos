// NamastePOS - Mobile POS: variant + modifier + note picker (F1, F2).
//
// Shown as a bottom-sheet when a menu item is tapped IF the item has any
// variants or modifier groups. Otherwise the tile calls quickAdd() directly.
//
// Variants → radio. Modifier groups → radio (single_select) or checkboxes
// (multi_select), with min/max enforcement. Note → free-text.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../models/cart_item.dart';
import '../../models/menu_item.dart';
import '../../providers/auth_provider.dart';
import '../../providers/orders_provider.dart';
import '../../services/api_service.dart';
import '../../utils/formatters.dart';

class ItemConfigSheet extends StatefulWidget {
  final MenuItem item;
  const ItemConfigSheet({super.key, required this.item});

  @override
  State<ItemConfigSheet> createState() => _ItemConfigSheetState();
}

class _ItemConfigSheetState extends State<ItemConfigSheet> {
  bool _loading = true;
  List<dynamic> _variants = [];
  List<dynamic> _groups = [];

  // Selections
  Map<String, dynamic>? _variant;
  // groupId -> set of optionId
  final Map<String, Set<String>> _picks = {};
  final _noteCtl = TextEditingController();
  int _qty = 1;

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
      // Backend serializes modifier groups under sprint1Extras /modifier-groups
      // (full payload), while /menu/:itemId/modifier-groups returns only the
      // attached IDs. So we fetch all groups + the IDs separately and join.
      final results = await Future.wait([
        ApiService.instance.listVariants(biz.id, widget.item.id),
        ApiService.instance.listAllModifierGroups(biz.id),
        ApiService.instance.getItemModifierGroupIds(biz.id, widget.item.id),
      ]);
      _variants = results[0];
      final List<dynamic> allGroups = results[1];
      final attachedIds = (results[2] as List<String>).toSet();
      _groups = allGroups.where((g) => attachedIds.contains((g as Map)['id'])).toList();

      // Sensible defaults
      if (_variants.isNotEmpty) _variant = _variants.first as Map<String, dynamic>;
      for (final g in _groups) {
        final gm = g as Map;
        final opts = (gm['modifiers'] as List?) ?? const [];
        final kind = gm['kind'] as String?;
        final minSelect = (gm['minSelect'] as num?)?.toInt() ?? 0;
        if (opts.isNotEmpty && (kind == 'single_select' || minSelect == 1)) {
          _picks[gm['id'] as String] = {opts.first['id'] as String};
        } else {
          _picks[gm['id'] as String] = {};
        }
      }
    } catch (_) {
      // Network or 404 just means "no variants/modifiers configured"
      _variants = []; _groups = [];
    }
    if (mounted) setState(() => _loading = false);
  }

  bool get _isValid {
    for (final g in _groups) {
      final gm = g as Map;
      final min = (gm['minSelect'] as num?)?.toInt() ?? 0;
      final max = (gm['maxSelect'] as num?)?.toInt() ?? 999;
      final picks = _picks[gm['id']]?.length ?? 0;
      if (picks < min) return false;
      if (picks > max) return false;
    }
    return true;
  }

  double get _previewUnit {
    double base = widget.item.price;
    if (_variant != null) {
      base = (_variant!['price'] as num?)?.toDouble()
          ?? (_variant!['price_inr'] as num?)?.toDouble()
          ?? base;
    }
    double addOns = 0;
    for (final g in _groups) {
      final gm = g as Map;
      final picked = _picks[gm['id']] ?? const <String>{};
      final opts = (gm['modifiers'] as List?) ?? const [];
      for (final o in opts) {
        final om = o as Map;
        if (picked.contains(om['id'])) {
          addOns += ((om['priceDeltaInr'] as num?)?.toDouble()
              ?? (om['price_delta_inr'] as num?)?.toDouble()
              ?? 0);
        }
      }
    }
    return base + addOns;
  }

  void _addAndClose() {
    final modifiers = <ModifierLine>[];
    for (final g in _groups) {
      final gm = g as Map;
      final picked = _picks[gm['id']] ?? const <String>{};
      final opts = (gm['modifiers'] as List?) ?? const [];
      for (final o in opts) {
        final om = o as Map;
        if (picked.contains(om['id'])) {
          modifiers.add(ModifierLine(
            groupId: gm['id'] as String?,
            groupLabel: (gm['name'] ?? gm['label']) as String? ?? 'Mod',
            optionId: om['id'] as String?,
            optionLabel: (om['name'] ?? om['label']) as String? ?? '',
            priceDelta: ((om['priceDeltaInr'] as num?)?.toDouble()
                ?? (om['price_delta_inr'] as num?)?.toDouble()
                ?? 0),
          ));
        }
      }
    }
    final line = CartItem(
      item: widget.item,
      qty: _qty,
      note: _noteCtl.text.trim().isEmpty ? null : _noteCtl.text.trim(),
      variantId: _variant?['id'] as String?,
      variantLabel: _variant?['label'] as String?,
      variantPrice: _variant != null
          ? ((_variant!['price'] as num?)?.toDouble()
              ?? (_variant!['price_inr'] as num?)?.toDouble())
          : null,
      modifiers: modifiers,
    );
    context.read<OrdersProvider>().addToCart(line);
    Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const SizedBox(
        height: 220,
        child: Center(child: CircularProgressIndicator()),
      );
    }

    return DraggableScrollableSheet(
      initialChildSize: 0.7,
      minChildSize: 0.4,
      maxChildSize: 0.95,
      expand: false,
      builder: (_, scrollCtl) => Container(
        decoration: const BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
        ),
        child: Column(
          children: [
            // Grab handle
            Container(
              width: 40, height: 4,
              margin: const EdgeInsets.symmetric(vertical: 10),
              decoration: BoxDecoration(
                color: AppColors.divider, borderRadius: BorderRadius.circular(2),
              ),
            ),
            // Header
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 12),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(widget.item.name,
                            style: const TextStyle(
                                fontSize: 18, fontWeight: FontWeight.w800)),
                        Text('Base ${AppFmt.money(widget.item.price)}',
                            style: const TextStyle(
                                fontSize: 12, color: AppColors.textSecondary)),
                      ],
                    ),
                  ),
                  IconButton(
                    icon: const Icon(Icons.close),
                    onPressed: () => Navigator.pop(context),
                  ),
                ],
              ),
            ),
            const Divider(height: 1),

            // Body
            Expanded(
              child: ListView(
                controller: scrollCtl,
                padding: const EdgeInsets.all(20),
                children: [
                  if (_variants.isNotEmpty) ...[
                    const _SectionHeader(label: 'Size / Variant'),
                    ..._variants.map((v) => _variantTile(v as Map<String, dynamic>)),
                    const SizedBox(height: 16),
                  ],
                  ..._groups.map((g) => _groupBlock(g as Map<String, dynamic>)),
                  const SizedBox(height: 8),
                  const _SectionHeader(label: 'Special instructions'),
                  TextField(
                    controller: _noteCtl,
                    maxLines: 2,
                    decoration: InputDecoration(
                      hintText: 'e.g. extra spicy, no onion',
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(8),
                        borderSide: const BorderSide(color: AppColors.divider),
                      ),
                    ),
                  ),
                  const SizedBox(height: 14),
                  Row(
                    children: [
                      const Text('Quantity',
                          style: TextStyle(fontWeight: FontWeight.w700)),
                      const Spacer(),
                      _qtyStep(Icons.remove, () {
                        if (_qty > 1) setState(() => _qty--);
                      }),
                      Container(
                        margin: const EdgeInsets.symmetric(horizontal: 12),
                        child: Text('$_qty',
                            style: const TextStyle(
                                fontSize: 18, fontWeight: FontWeight.w800)),
                      ),
                      _qtyStep(Icons.add, () => setState(() => _qty++)),
                    ],
                  ),
                ],
              ),
            ),

            // CTA
            SafeArea(
              top: false,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(20, 8, 20, 12),
                child: SizedBox(
                  height: 50,
                  child: ElevatedButton(
                    onPressed: _isValid ? _addAndClose : null,
                    child: Text(
                      'Add — ${AppFmt.money(_previewUnit * _qty, decimals: true)}',
                      style: const TextStyle(
                          fontSize: 16, fontWeight: FontWeight.w800),
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _variantTile(Map<String, dynamic> v) {
    final selected = _variant?['id'] == v['id'];
    final price = (v['price'] as num?)?.toDouble()
        ?? (v['price_inr'] as num?)?.toDouble()
        ?? widget.item.price;
    return RadioListTile<String>(
      value: v['id'] as String,
      groupValue: _variant?['id'] as String?,
      onChanged: (_) => setState(() => _variant = v),
      title: Text(v['label'] as String? ?? '?'),
      subtitle: Text(AppFmt.money(price)),
      activeColor: AppColors.primary,
      selected: selected,
      dense: true,
      contentPadding: EdgeInsets.zero,
    );
  }

  Widget _groupBlock(Map<String, dynamic> g) {
    final isMulti = g['kind'] == 'multi_select';
    final min = (g['minSelect'] as num?)?.toInt() ?? 0;
    final max = (g['maxSelect'] as num?)?.toInt() ?? (isMulti ? 999 : 1);
    final opts = (g['modifiers'] as List?) ?? const [];
    final gid = g['id'] as String;
    final picks = _picks[gid] ?? <String>{};
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _SectionHeader(
            label: (g['name'] ?? g['label']) as String? ?? '?',
            suffix: isMulti
                ? 'Pick ${min == max ? min : "$min–$max"}'
                : (min == 1 ? 'Required' : 'Optional')),
        ...opts.map((o) {
          final om = o as Map;
          final oid = om['id'] as String;
          final delta = (om['priceDeltaInr'] as num?)?.toDouble()
              ?? (om['price_delta_inr'] as num?)?.toDouble()
              ?? 0;
          if (isMulti) {
            return CheckboxListTile(
              value: picks.contains(oid),
              onChanged: (v) => setState(() {
                if (v == true) {
                  if (picks.length >= max) return;
                  picks.add(oid);
                } else {
                  picks.remove(oid);
                }
                _picks[gid] = picks;
              }),
              title: Text(om['name'] as String? ?? om['label'] as String? ?? '?'),
              subtitle: delta == 0 ? null : Text('+${AppFmt.money(delta)}'),
              activeColor: AppColors.primary,
              dense: true,
              controlAffinity: ListTileControlAffinity.leading,
              contentPadding: EdgeInsets.zero,
            );
          }
          return RadioListTile<String>(
            value: oid,
            groupValue: picks.isEmpty ? null : picks.first,
            onChanged: (v) => setState(() {
              _picks[gid] = {if (v != null) v};
            }),
            title: Text(om['name'] as String? ?? om['label'] as String? ?? '?'),
            subtitle: delta == 0 ? null : Text('+${AppFmt.money(delta)}'),
            activeColor: AppColors.primary,
            dense: true,
            contentPadding: EdgeInsets.zero,
          );
        }),
        const SizedBox(height: 12),
      ],
    );
  }

  Widget _qtyStep(IconData icon, VoidCallback onTap) {
    return Material(
      color: AppColors.primary,
      borderRadius: BorderRadius.circular(8),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(8),
        child: Padding(
          padding: const EdgeInsets.all(6),
          child: Icon(icon, color: Colors.white, size: 18),
        ),
      ),
    );
  }
}

class _SectionHeader extends StatelessWidget {
  final String label;
  final String? suffix;
  const _SectionHeader({required this.label, this.suffix});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 4, bottom: 8),
      child: Row(
        children: [
          Text(label,
              style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 13)),
          const Spacer(),
          if (suffix != null)
            Text(suffix!,
                style: const TextStyle(
                    fontSize: 11, color: AppColors.textSecondary)),
        ],
      ),
    );
  }
}
