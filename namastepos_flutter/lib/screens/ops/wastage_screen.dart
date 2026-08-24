// NamastePOS — Mobile wastage log (H11).
//
// Quick form to record spoilage / expired / broken stock. Lets a kitchen
// staffer pick an ingredient or menu item, qty, reason. The backend
// debits inventory + tags an `inventory_transactions` row with reason
// "wastage" so reports separate it from sales-driven consumption.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../utils/error_humanizer.dart';
import '../../providers/auth_provider.dart';
import '../../providers/menu_provider.dart';
import '../../services/api_service.dart';
import '../../utils/formatters.dart';
import '../../widgets/home_bottom_nav.dart';
import '../../widgets/home_drawer_button.dart';

class WastageScreen extends StatefulWidget {
  const WastageScreen({super.key});

  @override
  State<WastageScreen> createState() => _WastageScreenState();
}

class _WastageScreenState extends State<WastageScreen> {
  String? _itemId;
  final _qty = TextEditingController(text: '1');
  String _reason = 'expired';   // default — must be one of _reasons below
  final _notes = TextEditingController();
  bool _busy = false;

  // Must match backend Joi enum: 'expired','spilled','over_prep','damaged','other'
  static const _reasons = ['expired', 'spilled', 'over_prep', 'damaged', 'other'];
  // Human labels for the chips — raw snake_case looked broken on device.
  static const _reasonLabels = {
    'expired': 'Expired',
    'spilled': 'Spilled',
    'over_prep': 'Over-prepared',
    'damaged': 'Damaged',
    'other': 'Other',
  };

  // Recent wastage entries (founder feedback 22 Aug: after saving there
  // was no confirmation history anywhere — looked like nothing saved).
  List<dynamic> _recent = [];
  bool _loadingRecent = true;

  @override
  void initState() {
    super.initState();
    _loadRecent();
  }

  @override
  void dispose() {
    // M6 (2026-08-23, review): controllers were never disposed.
    _qty.dispose();
    _notes.dispose();
    super.dispose();
  }

  Future<void> _loadRecent() async {
    final biz = context.read<AuthProvider>().business;
    if (biz == null) { setState(() => _loadingRecent = false); return; }
    try {
      final report = await ApiService.instance.wastageReport(biz.id);
      if (!mounted) return;
      setState(() {
        _recent = (report['recent'] as List?) ?? [];
        _loadingRecent = false;
      });
    } catch (_) {
      if (mounted) setState(() => _loadingRecent = false);
    }
  }

  Future<void> _submit() async {
    final biz = context.read<AuthProvider>().business;
    if (biz == null || _itemId == null) return;
    setState(() => _busy = true);
    try {
      // Cost: derive from the item's cost price (fallback: selling price)
      // so wastage shows up with a rupee value in the P&L instead of ₹0.
      final qty = double.tryParse(_qty.text) ?? 0;
      final item = context.read<MenuProvider>().visibleItems
          .where((m) => m.id == _itemId).toList();
      final unitCost = item.isNotEmpty
          ? ((item.first.costPrice ?? 0) > 0
              ? item.first.costPrice!
              : item.first.price)
          : 0.0;
      // Backend schema uses singular `note`, not plural `notes`.
      await ApiService.instance.logWastage(biz.id, {
        'menuItemId': _itemId,
        'qty': qty,
        'reason': _reason,
        if (unitCost > 0) 'costPaise': (unitCost * qty * 100).round(),
        if (_notes.text.isNotEmpty) 'note': _notes.text,
      });
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Wastage logged ✓')),
        );
        // Stay on the screen and show the new entry in the history list
        // below (founder feedback: popping made it look like nothing
        // was saved).
        _notes.clear();
        _qty.text = '1';
        setState(() => _itemId = null);
        await _loadRecent();
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(humanizeError(e)), backgroundColor: Colors.red),
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final menu = context.watch<MenuProvider>().visibleItems;
    return Scaffold(
      appBar: AppBar(
        leading: (ModalRoute.of(context)?.isFirst ?? true) ? const HomeDrawerButton() : null,
        title: const Text('Log wastage')),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: ListView(
            children: [
              const Text('Item',
                  style: TextStyle(fontWeight: FontWeight.w800)),
              const SizedBox(height: 6),
              DropdownButtonFormField<String>(
                value: _itemId,
                hint: const Text('Pick a menu item'),
                isExpanded: true,
                items: menu
                    .map((m) => DropdownMenuItem(
                          value: m.id,
                          child: Text(m.name, overflow: TextOverflow.ellipsis),
                        ))
                    .toList(),
                onChanged: (v) => setState(() => _itemId = v),
              ),
              const SizedBox(height: 16),
              TextField(
                controller: _qty,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                decoration: const InputDecoration(
                  labelText: 'Quantity', border: OutlineInputBorder()),
              ),
              const SizedBox(height: 16),
              const Text('Reason',
                  style: TextStyle(fontWeight: FontWeight.w800)),
              const SizedBox(height: 6),
              Wrap(
                spacing: 8,
                runSpacing: 4,
                children: _reasons
                    .map((r) => ChoiceChip(
                          // Visibility fix (2026-08-22, founder screenshot):
                          // unselected labels inherited a theme color that
                          // rendered invisible (white on white). Explicit
                          // color + human label.
                          label: Text(_reasonLabels[r] ?? r),
                          selected: _reason == r,
                          selectedColor: AppColors.primary,
                          labelStyle: TextStyle(
                              color: _reason == r
                                  ? Colors.white
                                  : AppColors.textPrimary,
                              fontWeight: FontWeight.w700),
                          onSelected: (_) => setState(() => _reason = r),
                        ))
                    .toList(),
              ),
              const SizedBox(height: 16),
              TextField(
                controller: _notes,
                maxLines: 3,
                decoration: const InputDecoration(
                  labelText: 'Notes (optional)',
                  border: OutlineInputBorder()),
              ),
              const SizedBox(height: 24),
              SizedBox(
                height: 50,
                child: ElevatedButton(
                  onPressed: _busy || _itemId == null ? null : _submit,
                  child: _busy
                      ? const SizedBox(height: 20, width: 20,
                          child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                      : const Text('Save wastage',
                          style: TextStyle(fontWeight: FontWeight.w800)),
                ),
              ),
              const SizedBox(height: 24),
              // Recent wastage history (founder feedback 22 Aug): every
              // saved entry shows here immediately so the owner can see
              // it actually saved.
              const Text('Recent wastage',
                  style: TextStyle(fontWeight: FontWeight.w800)),
              const SizedBox(height: 6),
              if (_loadingRecent)
                const Padding(
                  padding: EdgeInsets.all(16),
                  child: Center(child: CircularProgressIndicator()),
                )
              else if (_recent.isEmpty)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 12),
                  child: Text('Nothing logged yet.',
                      style: TextStyle(color: AppColors.textSecondary)),
                )
              else
                ..._recent.take(20).map((e) {
                  final m = e as Map;
                  final name = m['menu_item_name'] ??
                      m['ingredient_name'] ?? 'Item';
                  final when = DateTime.tryParse(
                      (m['created_at'] ?? m['createdAt'] ?? '').toString());
                  final costPaise = (m['cost_paise'] as num?)?.toInt() ?? 0;
                  return Container(
                    margin: const EdgeInsets.only(bottom: 6),
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: AppColors.surface,
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: AppColors.divider),
                    ),
                    child: Row(
                      children: [
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text('${m['qty']}× $name',
                                  style: const TextStyle(
                                      fontWeight: FontWeight.w700)),
                              Text(
                                '${_reasonLabels[m['reason']] ?? m['reason']}'
                                '${when != null ? ' · ${AppFmt.dateShort(when)} ${AppFmt.time(when)}' : ''}',
                                style: const TextStyle(
                                    fontSize: 12,
                                    color: AppColors.textSecondary),
                              ),
                            ],
                          ),
                        ),
                        if (costPaise > 0)
                          Text(AppFmt.moneyPaise(costPaise),
                              style: const TextStyle(
                                  fontWeight: FontWeight.w800,
                                  color: AppColors.error)),
                      ],
                    ),
                  );
                }),
            ],
          ),
        ),
      ),
    bottomNavigationBar: const HomeBottomNav(),
    );
  }
}
