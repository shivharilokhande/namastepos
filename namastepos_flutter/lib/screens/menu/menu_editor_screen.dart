// NamastePOS — Mobile menu editor (Push 7 — full dashboard parity inc. variants).
//
// Top-level list of menu items (search + sold-out toggle + edit).
// Tapping "+" or an item opens _MenuItemEditScreen which mirrors every
// field the dashboard offers: name, category, selling price, description,
// image picker (camera or gallery, uploaded via /v1/businesses/:id/uploads),
// veg/active toggles, cost price, stock, reorder level, unit, prep time,
// display order, plus variants (price-and-stock siblings) and modifier-group
// attachment (catalog-level groups linked into the item).
//
// Variants + modifier groups are Pro-tier features. Like the dashboard, we
// always show the UI and quietly swallow 402 FEATURE_LOCKED responses on
// save — the base item still saves, the extras just no-op until upgrade.

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:image_picker/image_picker.dart';
import 'package:dio/dio.dart';

import '../../constants/colors.dart';
import '../../utils/error_humanizer.dart';
import '../../models/menu_item.dart';
import '../../providers/auth_provider.dart';
import '../../providers/menu_provider.dart';
import '../../services/api_service.dart';
import '../../utils/formatters.dart';
import '../../utils/image_url.dart';
import '../../widgets/home_bottom_nav.dart';
import '../../widgets/home_drawer_button.dart';

class MenuEditorScreen extends StatefulWidget {
  const MenuEditorScreen({super.key});

  @override
  State<MenuEditorScreen> createState() => _MenuEditorScreenState();
}

class _MenuEditorScreenState extends State<MenuEditorScreen> {
  String _search = '';

  @override
  Widget build(BuildContext context) {
    final menu = context.watch<MenuProvider>();
    final items = menu.visibleItems.where((m) {
      if (_search.isEmpty) return true;
      return m.name.toLowerCase().contains(_search.toLowerCase());
    }).toList();

    return Scaffold(
      appBar: AppBar(
        leading: (ModalRoute.of(context)?.isFirst ?? true) ? const HomeDrawerButton() : null,
        title: const Text('Menu editor'),
        actions: [
          IconButton(
            icon: const Icon(Icons.add),
            onPressed: () => _openEdit(null),
          ),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(12),
            child: TextField(
              onChanged: (v) => setState(() => _search = v),
              decoration: InputDecoration(
                hintText: 'Search menu',
                prefixIcon: const Icon(Icons.search),
                isDense: true,
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                  borderSide: const BorderSide(color: AppColors.divider),
                ),
              ),
            ),
          ),
          Expanded(
            child: items.isEmpty
                ? const Center(child: Text('No items — tap + to add one'))
                : ListView.separated(
                    itemCount: items.length,
                    separatorBuilder: (_, __) => const Divider(height: 1),
                    itemBuilder: (_, i) => _row(items[i]),
                  ),
          ),
        ],
      ),
    bottomNavigationBar: const HomeBottomNav(),
    );
  }

  Widget _row(MenuItem m) {
    return ListTile(
      // Image thumb — pulls from /uploads via the API origin
      leading: m.imageUrl != null && m.imageUrl!.isNotEmpty
          ? ClipRRect(
              borderRadius: BorderRadius.circular(6),
              // NP-140: cached + decoded at ~2× the 44 lp thumb, not full-res.
              child: CachedNetworkImage(
                imageUrl: _fullImage(m.imageUrl!),
                width: 44, height: 44, fit: BoxFit.cover,
                memCacheWidth: 88,
                placeholder: (_, __) => Container(
                    width: 44, height: 44, color: AppColors.background),
                errorWidget: (_, __, ___) => _vegDot(m),
              ),
            )
          : _vegDot(m),
      title: Text(m.name, style: const TextStyle(fontWeight: FontWeight.w700)),
      subtitle: Text('${m.category} · ${AppFmt.money(m.price)}'),
      // Redesign (2026-08-22): the text button "Sold out / Available"
      // was ambiguous — read as a status label rather than an action.
      // Owner also wanted the availability tied to inventory.
      //   * Green "AVAILABLE" pill + Switch when active
      //   * Red   "SOLD OUT"  pill + Switch when inactive OR stock ≤ 0
      // Auto-forces sold-out when stock hits zero — the Switch is
      // disabled in that case (owner has to restock first).
      trailing: Wrap(
        spacing: 6,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          _availabilityChip(m),
          IconButton(
            icon: const Icon(Icons.edit, size: 18),
            onPressed: () => _openEdit(m),
          ),
        ],
      ),
    );
  }

  /// Inventory-linked availability chip. Tap the switch to toggle
  /// active/sold-out. When stock is 0 the item is force-shown as
  /// sold out and the switch is disabled until the owner adds stock
  /// via Inventory → Adjust.
  Widget _availabilityChip(MenuItem m) {
    final outOfStock = m.stock <= 0;
    // Fix (2026-08-23): the toggle writes sold_out_until, but this chip
    // only looked at isActive — so "Marked sold-out" never flipped the
    // switch. isSoldOut is now part of the availability calculation.
    final effectivelyAvailable = m.isActive && !outOfStock && !m.isSoldOut;
    final label = effectivelyAvailable ? 'AVAILABLE' : 'SOLD OUT';
    final chipColor = effectivelyAvailable ? AppColors.success : AppColors.error;

    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        // Status pill
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
          decoration: BoxDecoration(
            color: chipColor.withValues(alpha: 0.12),
            borderRadius: BorderRadius.circular(10),
          ),
          child: Text(
            label,
            style: TextStyle(
              color: chipColor,
              fontWeight: FontWeight.w900,
              fontSize: 10,
              letterSpacing: 1.0,
            ),
          ),
        ),
        // Small toggle. Disabled when stock=0 — owner has to restock
        // via Inventory first (prevents accidentally serving items
        // that aren't in the fridge).
        Transform.scale(
          scale: 0.75,
          child: Switch(
            value: effectivelyAvailable,
            onChanged: outOfStock ? null : (v) => _toggleSoldOut(m),
            activeThumbColor: AppColors.success,
          ),
        ),
        if (outOfStock)
          Padding(
            padding: const EdgeInsets.only(left: 2),
            child: Text(
              '0 stock',
              style: TextStyle(
                color: AppColors.textSecondary,
                fontSize: 9,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
      ],
    );
  }

  Widget _vegDot(MenuItem m) {
    return Container(
      width: 14, height: 14,
      decoration: BoxDecoration(
        border: Border.all(
            color: m.isVeg ? AppColors.success : AppColors.error, width: 1.5),
      ),
      child: Center(
        child: Container(
          width: 6, height: 6,
          decoration: BoxDecoration(
            color: m.isVeg ? AppColors.success : AppColors.error,
            shape: BoxShape.circle,
          ),
        ),
      ),
    );
  }

  Future<void> _toggleSoldOut(MenuItem m) async {
    final biz = context.read<AuthProvider>().business!;
    // Fix (2026-08-23): base the direction on the SOLD-OUT state, not
    // isActive (which this toggle never changes).
    final makingAvailable = m.isSoldOut;
    final mode = makingAvailable ? 'available' : 'forever';
    try {
      await ApiService.instance.setItemSoldOut(biz.id, m.id, mode);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(
            makingAvailable ? 'Back in stock ✓' : 'Marked sold-out')),
      );
      await context.read<MenuProvider>().load(biz.id);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(humanizeError(e))),
        );
      }
    }
  }

  Future<void> _openEdit(MenuItem? m) async {
    await Navigator.push(context, MaterialPageRoute(
      builder: (_) => _MenuItemEditScreen(item: m),
    ));
    if (!mounted) return;
    final biz = context.read<AuthProvider>().business;
    if (biz != null) await context.read<MenuProvider>().load(biz.id);
  }
}

/// Helper for image preview — relative /uploads/... → API origin.
// M1 (2026-08-23, review): duplicate of utils/image_url.fullImageUrl —
// delegate to the shared helper so the resolution logic lives once.
String _fullImage(String url) => fullImageUrl(url);

// ──────────────────────────────────────────────────────────────────────────
//                          EDIT / CREATE SCREEN
// ──────────────────────────────────────────────────────────────────────────

class _MenuItemEditScreen extends StatefulWidget {
  final MenuItem? item;
  const _MenuItemEditScreen({this.item});

  @override
  State<_MenuItemEditScreen> createState() => _MenuItemEditScreenState();
}

class _MenuItemEditScreenState extends State<_MenuItemEditScreen> {
  late final TextEditingController _name;
  late final TextEditingController _description;
  late final TextEditingController _price;
  late final TextEditingController _category;
  late final TextEditingController _sku;
  late final TextEditingController _costPrice;
  late final TextEditingController _stock;
  late final TextEditingController _reorder;
  late final TextEditingController _prepMinutes;
  late final TextEditingController _displayOrder;
  String _unit = 'piece';
  bool _isVeg = true;
  bool _isActive = true;
  String _imageUrl = '';
  bool _uploading = false;
  bool _saving = false;

  // ── Variants + modifier groups (Push 7) ────────────────────────────────
  // Each variant: { id?, label, price, sku }. New rows have no id.
  final List<_VariantDraft> _variants = [];
  // All catalog modifier groups for this business (read-only).
  List<Map<String, dynamic>> _allGroups = [];
  // IDs of groups currently attached to this item — drives the checkbox state.
  final Set<String> _attachedGroupIds = {};
  bool _extrasLoading = false;
  bool _extrasLockedHint = false; // surfaced when backend 402s on save

  static const _units = ['piece', 'kg', 'gram', 'liter', 'ml', 'plate'];

  @override
  void initState() {
    super.initState();
    final m = widget.item;
    _name = TextEditingController(text: m?.name ?? '');
    _description = TextEditingController(text: m?.description ?? '');
    _price = TextEditingController(text: (m?.price ?? 0).toString());
    _category = TextEditingController(text: m?.category ?? 'Food');
    _sku = TextEditingController(text: m?.sku ?? '');
    _costPrice = TextEditingController(text: (m?.costPrice ?? 0).toString());
    _stock = TextEditingController(text: (m?.stock ?? 0).toString());
    _reorder = TextEditingController(text: (m?.reorderLevel ?? 10).toString());
    _prepMinutes = TextEditingController(text: '');
    _displayOrder = TextEditingController(text: '100');
    _unit = m?.unit.name ?? 'piece';
    _isVeg = m?.isVeg ?? true;
    _isActive = m?.isActive ?? true;
    _imageUrl = m?.imageUrl ?? '';
    // Kick off the extras fetch (variants + catalog groups + currently
    // attached IDs). Failures are non-fatal — Starter plans 402 and the
    // sections just render empty. We don't await; the UI rebuilds when
    // setState fires inside _loadExtras.
    WidgetsBinding.instance.addPostFrameCallback((_) => _loadExtras());
  }

  Future<void> _loadExtras() async {
    final biz = context.read<AuthProvider>().business;
    if (biz == null) return;
    setState(() => _extrasLoading = true);
    final api = ApiService.instance;
    final itemId = widget.item?.id;

    try {
      // Catalog groups are always business-scoped, even for new items, so
      // we can show the attach UI before the first save.
      final groups = await api.listAllModifierGroups(biz.id);
      _allGroups = groups.cast<Map<String, dynamic>>();
    } catch (_) { /* 402 on Starter, network glitch — ignore */ }

    if (itemId != null) {
      try {
        final variants = await api.listVariants(biz.id, itemId);
        _variants
          ..clear()
          ..addAll(variants.map((v) => _VariantDraft.fromJson(v as Map)));
      } catch (_) { /* keep editor usable even if fetch fails */ }
      try {
        final ids = await api.getItemModifierGroupIds(biz.id, itemId);
        _attachedGroupIds
          ..clear()
          ..addAll(ids);
      } catch (_) { /* ignore */ }
    }

    if (mounted) setState(() => _extrasLoading = false);
  }

  @override
  void dispose() {
    _name.dispose(); _description.dispose(); _price.dispose(); _category.dispose();
    _sku.dispose(); _costPrice.dispose(); _stock.dispose(); _reorder.dispose();
    _prepMinutes.dispose(); _displayOrder.dispose();
    super.dispose();
  }

  Future<void> _pickImage(ImageSource src) async {
    final f = await ImagePicker().pickImage(source: src, imageQuality: 85, maxWidth: 1600);
    if (f == null || !mounted) return;
    setState(() => _uploading = true);
    try {
      final biz = context.read<AuthProvider>().business!;
      // Multipart upload via dio (use the shared instance so the Bearer
      // auth interceptor attaches the JWT).
      final form = FormData.fromMap({
        'file': await MultipartFile.fromFile(f.path,
            filename: f.name),
      });
      final r = await ApiService.instance.dio.post(
        '/businesses/${biz.id}/uploads',
        data: form,
      );
      final url = (r.data as Map)['url'] as String;
      if (mounted) setState(() => _imageUrl = url);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text("Couldn't upload the image — " + humanizeError(e))),
        );
      }
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
  }

  Future<void> _save() async {
    if (_name.text.trim().isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Item name is required')));
      return;
    }
    final price = double.tryParse(_price.text) ?? 0;
    if (price <= 0) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Selling price must be greater than zero')));
      return;
    }

    setState(() => _saving = true);
    final biz = context.read<AuthProvider>().business!;
    final body = <String, dynamic>{
      'name': _name.text.trim(),
      'price': price,
      'category': _category.text.trim().isEmpty ? 'Food' : _category.text.trim(),
      if (_description.text.isNotEmpty) 'description': _description.text.trim(),
      if (_sku.text.isNotEmpty) 'sku': _sku.text.trim(),
      'unit': _unit,
      'stock': double.tryParse(_stock.text) ?? 0,
      'reorderLevel': double.tryParse(_reorder.text) ?? 10,
      'costPrice': double.tryParse(_costPrice.text) ?? 0,
      'isVeg': _isVeg,
      'isActive': _isActive,
      if (_imageUrl.isNotEmpty) 'imageUrl': _imageUrl,
      if (_prepMinutes.text.isNotEmpty)
        'prepMinutes': int.tryParse(_prepMinutes.text),
      'displayOrder': int.tryParse(_displayOrder.text) ?? 100,
    };
    try {
      final saved = await ApiService.instance.upsertMenuItem(
        biz.id, body, id: widget.item?.id);
      // The backend wraps the row as { item: {...} }; extract the id for
      // variant / modifier-group persistence (works for both create + edit).
      final itemId = (saved['item'] is Map)
          ? (saved['item'] as Map)['id']?.toString() ?? widget.item?.id
          : widget.item?.id;

      // Persist variants + modifier-group attachments. Both 402 on Starter;
      // we swallow that specific status so the base item still saves. Any
      // other error surfaces as a snackbar but doesn't undo the item save —
      // mirroring the dashboard's behavior in MenuPage.tsx EditDialog.
      if (itemId != null) {
        var extrasLocked = false;
        final cleanVariants = _variants
            .where((v) => v.label.trim().isNotEmpty && v.price >= 0)
            .map((v) => v.toJson())
            .toList();
        // Push variants if we have any to write OR if we used to have some
        // and the user removed them all (replace-all semantics).
        if (cleanVariants.isNotEmpty || widget.item != null) {
          try {
            await ApiService.instance.setVariants(biz.id, itemId, cleanVariants);
          } on ApiException catch (err) {
            if (err.statusCode == 402) {
              extrasLocked = true;
            } else if (cleanVariants.isNotEmpty) {
              rethrow;
            }
          }
        }
        try {
          await ApiService.instance.setItemModifierGroups(
              biz.id, itemId, _attachedGroupIds.toList());
        } on ApiException catch (err) {
          if (err.statusCode == 402) {
            extrasLocked = true;
          } else if (_attachedGroupIds.isNotEmpty) {
            rethrow;
          }
        }

        if (extrasLocked && mounted) {
          // Don't block the user — the base item saved. Just nudge them.
          // Bug fix: must use setState() so the bottom-of-form hint actually
          // re-renders, not just the snackbar.
          setState(() { _extrasLockedHint = true; });
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text(
                'Item saved. Variants & modifier groups need the Pro plan.'),
            duration: Duration(seconds: 3),
          ));
        }
      }

      if (!mounted) return;
      Navigator.pop(context);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text("Couldn't save the item — " + humanizeError(e))),
        );
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        // Explicit close (X) — clearer than the default back arrow for a
        // "New item / Edit item" modal-flow screen. Bug fix (2026-08-22):
        // the user asked "where's cancel?" — the back arrow was there but
        // read as navigation, not "cancel this edit". Now the leading X +
        // an explicit "Cancel" text button in actions make the escape
        // hatch unambiguous.
        leading: IconButton(
          icon: const Icon(Icons.close),
          tooltip: 'Cancel',
          onPressed: () => Navigator.of(context).maybePop(),
        ),
        title: Text(widget.item == null ? 'New item' : 'Edit item'),
        actions: [
          TextButton(
            onPressed: _saving
                ? null
                : () => Navigator.of(context).maybePop(),
            child: const Text('Cancel',
                style: TextStyle(color: AppColors.textSecondary)),
          ),
          TextButton(
            onPressed: _saving ? null : _save,
            child: Text(
              widget.item == null ? 'Save' : 'Update',
              style: const TextStyle(fontWeight: FontWeight.w800),
            ),
          ),
        ],
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            // ── Image picker ───────────────────────────────────────────────
            Container(
              decoration: BoxDecoration(
                border: Border.all(color: AppColors.divider),
                borderRadius: BorderRadius.circular(12),
              ),
              padding: const EdgeInsets.all(12),
              child: Row(
                children: [
                  Container(
                    width: 84, height: 84,
                    decoration: BoxDecoration(
                      color: AppColors.surface,
                      border: Border.all(color: AppColors.divider),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: _uploading
                        ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
                        : (_imageUrl.isNotEmpty
                            ? ClipRRect(
                                borderRadius: BorderRadius.circular(8),
                                // NP-140: cached + decoded at ~2× the 84 lp box.
                                child: CachedNetworkImage(
                                  imageUrl: _fullImage(_imageUrl),
                                  fit: BoxFit.cover,
                                  memCacheWidth: 168,
                                  placeholder: (_, __) => const Center(
                                      child: CircularProgressIndicator(strokeWidth: 2)),
                                  errorWidget: (_, __, ___) =>
                                      const Icon(Icons.broken_image, color: AppColors.textHint),
                                ),
                              )
                            : const Icon(Icons.image_outlined,
                                size: 32, color: AppColors.textHint)),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        const Text('Item photo',
                            style: TextStyle(fontWeight: FontWeight.w700)),
                        const SizedBox(height: 6),
                        Row(
                          children: [
                            Expanded(
                              child: OutlinedButton.icon(
                                icon: const Icon(Icons.camera_alt, size: 16),
                                label: const Text('Camera'),
                                onPressed: _uploading
                                    ? null
                                    : () => _pickImage(ImageSource.camera),
                              ),
                            ),
                            const SizedBox(width: 6),
                            Expanded(
                              child: OutlinedButton.icon(
                                icon: const Icon(Icons.photo_library, size: 16),
                                label: const Text('Gallery'),
                                onPressed: _uploading
                                    ? null
                                    : () => _pickImage(ImageSource.gallery),
                              ),
                            ),
                          ],
                        ),
                        if (_imageUrl.isNotEmpty)
                          TextButton(
                            onPressed: () => setState(() => _imageUrl = ''),
                            child: const Text('Remove photo',
                                style: TextStyle(color: AppColors.error)),
                          ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),

            // ── Basics ─────────────────────────────────────────────────────
            _section('Basics'),
            TextField(
              controller: _name,
              textCapitalization: TextCapitalization.words,
              decoration: const InputDecoration(
                  labelText: 'Name *', border: OutlineInputBorder()),
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _category,
                    decoration: const InputDecoration(
                        labelText: 'Category', border: OutlineInputBorder()),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: TextField(
                    controller: _price,
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    decoration: const InputDecoration(
                        labelText: 'Selling price (₹) *',
                        border: OutlineInputBorder()),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _description,
              maxLines: 2,
              decoration: const InputDecoration(
                  labelText: 'Short description', border: OutlineInputBorder()),
            ),
            const SizedBox(height: 16),

            // ── Inventory ──────────────────────────────────────────────────
            _section('Inventory'),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _costPrice,
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    decoration: const InputDecoration(
                        labelText: 'Cost price (₹)', border: OutlineInputBorder()),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: TextField(
                    controller: _stock,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(
                        labelText: 'Stock', border: OutlineInputBorder()),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _reorder,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(
                        labelText: 'Reorder at', border: OutlineInputBorder()),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: DropdownButtonFormField<String>(
                    menuMaxHeight: 320, isExpanded: true, // scroll long lists (2026-08-25)
                    value: _unit,
                    decoration: const InputDecoration(
                        labelText: 'Unit', border: OutlineInputBorder()),
                    items: _units.map((u) =>
                        DropdownMenuItem(value: u, child: Text(u))).toList(),
                    onChanged: (v) => setState(() => _unit = v ?? 'piece'),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),

            // ── Service polish ─────────────────────────────────────────────
            _section('Service polish'),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _prepMinutes,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(
                        labelText: 'Prep time (mins)',
                        border: OutlineInputBorder()),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: TextField(
                    controller: _displayOrder,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(
                        labelText: 'Display order',
                        border: OutlineInputBorder()),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _sku,
              decoration: const InputDecoration(
                  labelText: 'SKU (optional)', border: OutlineInputBorder()),
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: SwitchListTile(
                    title: const Text('Veg'),
                    value: _isVeg,
                    activeThumbColor: AppColors.success,
                    onChanged: (v) => setState(() => _isVeg = v),
                    contentPadding: EdgeInsets.zero,
                  ),
                ),
                Expanded(
                  child: SwitchListTile(
                    title: const Text('Active'),
                    value: _isActive,
                    onChanged: (v) => setState(() => _isActive = v),
                    contentPadding: EdgeInsets.zero,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),

            // ── Variants ──────────────────────────────────────────────────
            _section('Variants'),
            _variantsBlock(),
            const SizedBox(height: 16),

            // ── Modifier groups ───────────────────────────────────────────
            _section('Modifier groups'),
            _modifierGroupsBlock(),
            const SizedBox(height: 24),

            // ── Save ───────────────────────────────────────────────────────
            SizedBox(
              width: double.infinity, height: 52,
              child: ElevatedButton(
                onPressed: _saving ? null : _save,
                child: _saving
                    ? const SizedBox(
                        height: 22, width: 22,
                        child: CircularProgressIndicator(
                            strokeWidth: 2.4, color: Colors.white))
                    : Text(widget.item == null ? 'Add to menu' : 'Save changes',
                        style: const TextStyle(
                            fontWeight: FontWeight.w900, fontSize: 16)),
              ),
            ),
            const SizedBox(height: 12),
            // Only mention the Pro gate if the last save attempt actually
            // 402'd. Otherwise the hint just nags users who already paid.
            if (_extrasLockedHint)
              const Text(
                'Variants and modifier groups are available on the Pro plan. '
                'Tap Plans & billing to upgrade.',
                style: TextStyle(color: AppColors.textHint, fontSize: 12),
                textAlign: TextAlign.center,
              ),
          ],
        ),
      ),
      bottomNavigationBar: const HomeBottomNav(),
    );
  }

  // ── Variants UI ─────────────────────────────────────────────────────────
  //
  // Replace-all semantics on save. Each row has label, price, optional SKU.
  // We keep the variant's original id for existing rows so the backend
  // updates in-place (preserving order_items FKs); new rows get inserted.
  Widget _variantsBlock() {
    return Container(
      decoration: BoxDecoration(
        border: Border.all(color: AppColors.divider),
        borderRadius: BorderRadius.circular(12),
      ),
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text(
            'Add price-and-stock siblings (e.g. Half / Full, S / M / L). '
            'Leave empty if this item has only one size.',
            style: TextStyle(fontSize: 12, color: AppColors.textSecondary),
          ),
          const SizedBox(height: 8),
          if (_variants.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 8),
              child: Text('No variants yet — tap "Add variant" below.',
                  style: TextStyle(color: AppColors.textHint, fontSize: 12)),
            )
          else
            ...List.generate(_variants.length, (i) => _variantRow(i)),
          const SizedBox(height: 6),
          OutlinedButton.icon(
            icon: const Icon(Icons.add, size: 16),
            label: const Text('Add variant'),
            onPressed: () {
              final basePrice = double.tryParse(_price.text) ?? 0;
              setState(() => _variants.add(
                    _VariantDraft(label: '', price: basePrice, sku: ''),
                  ));
            },
          ),
        ],
      ),
    );
  }

  Widget _variantRow(int i) {
    final v = _variants[i];
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          Expanded(
            flex: 3,
            child: TextFormField(
              initialValue: v.label,
              decoration: const InputDecoration(
                labelText: 'Label',
                isDense: true,
                border: OutlineInputBorder(),
              ),
              onChanged: (t) => v.label = t,
            ),
          ),
          const SizedBox(width: 6),
          Expanded(
            flex: 2,
            child: TextFormField(
              initialValue: v.price.toString(),
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              decoration: const InputDecoration(
                labelText: 'Price ₹',
                isDense: true,
                border: OutlineInputBorder(),
              ),
              onChanged: (t) => v.price = double.tryParse(t) ?? 0,
            ),
          ),
          const SizedBox(width: 6),
          Expanded(
            flex: 2,
            child: TextFormField(
              initialValue: v.sku,
              decoration: const InputDecoration(
                labelText: 'SKU',
                isDense: true,
                border: OutlineInputBorder(),
              ),
              onChanged: (t) => v.sku = t,
            ),
          ),
          IconButton(
            icon: const Icon(Icons.delete_outline, size: 20),
            color: AppColors.error,
            onPressed: () => setState(() => _variants.removeAt(i)),
          ),
        ],
      ),
    );
  }

  // ── Modifier-group attachment UI ────────────────────────────────────────
  //
  // The catalog of groups themselves is managed elsewhere (dashboard or
  // direct POST to /modifier-groups). Here we just toggle which existing
  // groups are linked to this item. If no groups exist yet, we surface a
  // hint pointing to the dashboard.
  Widget _modifierGroupsBlock() {
    return Container(
      decoration: BoxDecoration(
        border: Border.all(color: AppColors.divider),
        borderRadius: BorderRadius.circular(12),
      ),
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text(
            'Add-on / topping groups that the customer picks from at order '
            'time (e.g. "Spice level", "Extras").',
            style: TextStyle(fontSize: 12, color: AppColors.textSecondary),
          ),
          const SizedBox(height: 8),
          if (_extrasLoading)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 12),
              child: Center(
                child: SizedBox(
                  width: 22,
                  height: 22,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              ),
            )
          else if (_allGroups.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 6),
              child: Text(
                'No modifier groups exist yet. Create them on the web '
                'dashboard (Catalog → Modifier groups) and they will appear '
                'here.',
                style: TextStyle(color: AppColors.textHint, fontSize: 12),
              ),
            )
          else
            ..._allGroups.map(_modifierGroupTile),
        ],
      ),
    );
  }

  Widget _modifierGroupTile(Map<String, dynamic> g) {
    final id = g['id'] as String;
    final name = (g['name'] ?? g['label']) as String? ?? 'Group';
    final kind = g['kind'] as String? ?? 'single_select';
    final minSel = (g['minSelect'] as num?)?.toInt() ?? 0;
    final maxSel = (g['maxSelect'] as num?)?.toInt() ?? 1;
    final mods = (g['modifiers'] as List?) ?? const [];
    final modPreview = mods
        .take(3)
        .map((m) => (m as Map)['name']?.toString() ?? '')
        .where((s) => s.isNotEmpty)
        .join(', ');
    final more = mods.length > 3 ? ' +${mods.length - 3} more' : '';
    final kindLabel = kind == 'single_select' ? 'pick 1' : 'multi';

    return CheckboxListTile(
      value: _attachedGroupIds.contains(id),
      onChanged: (v) => setState(() {
        if (v == true) {
          _attachedGroupIds.add(id);
        } else {
          _attachedGroupIds.remove(id);
        }
      }),
      title: Text(name, style: const TextStyle(fontWeight: FontWeight.w700)),
      subtitle: Text(
        '$kindLabel ($minSel–$maxSel)${modPreview.isEmpty ? '' : ' · $modPreview$more'}',
        style: const TextStyle(fontSize: 11, color: AppColors.textSecondary),
      ),
      dense: true,
      controlAffinity: ListTileControlAffinity.leading,
      contentPadding: EdgeInsets.zero,
      activeColor: AppColors.primary,
    );
  }

  Widget _section(String label) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Text(label.toUpperCase(),
            style: const TextStyle(
                color: AppColors.textSecondary,
                fontSize: 11,
                fontWeight: FontWeight.w900,
                letterSpacing: 1.2)),
      );
}

// ──────────────────────────────────────────────────────────────────────────
// Local draft model for a variant row in the editor. We keep IDs around so
// the backend can update existing rows in-place rather than soft-delete +
// recreate (which would orphan historical order_items.variant_id refs).
// ──────────────────────────────────────────────────────────────────────────
class _VariantDraft {
  String? id;
  String label;
  double price;
  String sku;

  _VariantDraft({this.id, required this.label, required this.price, this.sku = ''});

  factory _VariantDraft.fromJson(Map v) => _VariantDraft(
        id: v['id']?.toString(),
        label: v['label']?.toString() ?? '',
        price: (v['price'] as num?)?.toDouble() ?? 0,
        sku: v['sku']?.toString() ?? '',
      );

  Map<String, dynamic> toJson() => {
        if (id != null) 'id': id,
        'label': label.trim(),
        'price': price,
        if (sku.trim().isNotEmpty) 'sku': sku.trim(),
      };
}
