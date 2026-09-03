// NamastePOS - New order entry (POS)
//
// Real-POS layout: menu grid on top, persistent cart panel at the bottom
// showing every line. Tap any item to add it; tapping the same item again
// just increments qty (same behavior as iPad-based POS apps). A floating
// cart drawer can be expanded to edit qty, remove lines, or add notes.

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../models/cart_item.dart';
import '../../models/menu_item.dart';
import '../../providers/menu_provider.dart';
import '../../providers/orders_provider.dart';
import '../../services/voice_order_service.dart';
import '../../utils/formatters.dart';
import '../../utils/image_url.dart';
import '../../widgets/home_drawer_button.dart';
import '../captain/captain_screen.dart' show pendingCaptainSession;
import 'confirm_order_screen.dart';
import 'item_config_sheet.dart';

class NewOrderScreen extends StatefulWidget {
  const NewOrderScreen({super.key});

  @override
  State<NewOrderScreen> createState() => _NewOrderScreenState();
}

class _NewOrderScreenState extends State<NewOrderScreen> {
  String _search = '';

  @override
  Widget build(BuildContext context) {
    final menu = context.watch<MenuProvider>();
    final orders = context.watch<OrdersProvider>();

    final filtered = menu.visibleItems.where((m) {
      if (_search.trim().isEmpty) return true;
      return m.name.toLowerCase().contains(_search.toLowerCase()) ||
          (m.sku ?? '').toLowerCase().contains(_search.toLowerCase());
    }).toList();

    // Reserve room at the bottom so the menu doesn't hide under the cart panel.
    // Empty cart: ~12px (FAB-free). With items: ~180px (collapsed cart sheet).
    final cartReserve = orders.cart.isEmpty ? 12.0 : 180.0;

    // Back arrow ONLY when the screen was launched from Captain's
    // "Add items" — that path sets pendingCaptainSession as a marker.
    // When opened as the POS bottom-nav tab (default case), keep the
    // hamburger so the user can reach the drawer normally. Per Shiv:
    // "back button not needed for new order, it's required only when
    // customer places more order on same table before paid".
    final fromCaptain = pendingCaptainSession != null;
    return Scaffold(
      appBar: AppBar(
        leading: fromCaptain
            ? IconButton(
                icon: const Icon(Icons.arrow_back),
                onPressed: () => Navigator.of(context).pop(),
              )
            : const HomeDrawerButton(),
        title: Text(fromCaptain
            ? 'Add to Table ${pendingCaptainSession!['tableLabel'] ?? ''}'
            : 'New Order'),
        actions: [
          IconButton(
            tooltip: 'Voice order',
            icon: const Icon(Icons.mic_rounded),
            onPressed: () => _voiceOrder(context),
          ),
          if (orders.cart.isNotEmpty)
            TextButton.icon(
              onPressed: () => _confirmClear(context, orders),
              icon: const Icon(Icons.clear, size: 18),
              label: const Text('Clear'),
              style: TextButton.styleFrom(foregroundColor: AppColors.error),
            ),
        ],
      ),
      body: Column(
        children: [
          // Search
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
            child: TextField(
              onChanged: (v) => setState(() => _search = v),
              decoration: InputDecoration(
                hintText: 'Search items, SKU…',
                prefixIcon: const Icon(Icons.search_rounded),
                contentPadding: const EdgeInsets.symmetric(horizontal: 16),
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

          // Categories
          SizedBox(
            height: 44,
            child: ListView.separated(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              scrollDirection: Axis.horizontal,
              itemBuilder: (_, i) {
                final c = menu.categories[i];
                final selected = c == menu.selectedCategory;
                return ChoiceChip(
                  label: Text(c),
                  selected: selected,
                  onSelected: (_) => menu.selectedCategory = c,
                  selectedColor: AppColors.primary,
                  labelStyle: TextStyle(
                    color: selected ? Colors.white : AppColors.textPrimary,
                    fontWeight: FontWeight.w600,
                    fontSize: 13,
                  ),
                );
              },
              separatorBuilder: (_, __) => const SizedBox(width: 8),
              itemCount: menu.categories.length,
            ),
          ),

          const SizedBox(height: 8),

          // Menu grid
          Expanded(
            child: filtered.isEmpty
                ? const Center(
                    child: Text('No items found',
                        style: TextStyle(color: AppColors.textSecondary)),
                  )
                : GridView.builder(
                    padding: EdgeInsets.fromLTRB(16, 8, 16, cartReserve + 12),
                    itemCount: filtered.length,
                    gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                      crossAxisCount: 2,
                      childAspectRatio: 1.05,
                      crossAxisSpacing: 12,
                      mainAxisSpacing: 12,
                    ),
                    itemBuilder: (_, i) => _MenuItemTile(item: filtered[i]),
                  ),
          ),
        ],
      ),

      // Persistent cart panel — collapsed by default, expandable to a full
      // bill view via a tap on the chevron.
      bottomSheet: orders.cart.isEmpty ? null : const _CartPanel(),
    );
  }

  Future<void> _voiceOrder(BuildContext context) async {
    final messenger = ScaffoldMessenger.of(context);
    if (!VoiceOrderService.instance.available) {
      messenger.showSnackBar(const SnackBar(
        content: Text('Voice ordering is disabled in this build. '
            'Use the menu grid to add items.'),
        duration: Duration(seconds: 3),
      ));
      return;
    }
    messenger.showSnackBar(const SnackBar(
        content: Text('Listening… say e.g. "two paneer tikka one naan"'),
        duration: Duration(seconds: 5)));
    final text = await VoiceOrderService.instance.listen();
    if (text == null || text.trim().isEmpty) {
      messenger.showSnackBar(const SnackBar(content: Text('No speech detected')));
      return;
    }
    // Guard the BuildContext reads below across the listen() async gap.
    if (!context.mounted) return;
    final menu = context.read<MenuProvider>().visibleItems;
    final parsed = VoiceOrderService.parse(text, menu);
    if (parsed.isEmpty) {
      messenger.showSnackBar(SnackBar(content: Text('No matches in "$text"')));
      return;
    }
    final orders = context.read<OrdersProvider>();
    final added = <String>[];
    final skipped = <String>[];
    for (final p in parsed) {
      // Bug fix: firstWhere without orElse throws StateError if the menu
      // mutates between parse and lookup. Use where().firstOrNull style.
      MenuItem? m;
      for (final x in menu) { if (x.name == p.name) { m = x; break; } }
      if (m == null) {
        skipped.add('${p.qty}× ${p.name}');
        continue;
      }
      orders.addToCart(CartItem(item: m, qty: p.qty));
      added.add('${p.qty}× ${p.name}');
    }
    final msg = added.isEmpty
        ? 'Could not match any items: ${skipped.join(", ")}'
        : 'Added ${added.join(", ")}${skipped.isEmpty ? "" : " (skipped ${skipped.join(", ")})"}';
    messenger.showSnackBar(SnackBar(content: Text(msg)));
  }

  void _confirmClear(BuildContext context, OrdersProvider orders) {
    showDialog(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Clear cart?'),
        content: const Text('All items in this order will be removed.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: AppColors.error),
            onPressed: () { orders.clearCart(); Navigator.pop(context); },
            child: const Text('Clear', style: TextStyle(color: Colors.white)),
          ),
        ],
      ),
    );
  }
}

class _MenuItemTile extends StatelessWidget {
  final MenuItem item;
  const _MenuItemTile({required this.item});

  @override
  Widget build(BuildContext context) {
    final orders = context.watch<OrdersProvider>();
    final qty = orders.qtyInCart(item.id);
    // 86'd (2026-08-23, founder): sold-out items stay visible but are
    // greyed out and unselectable, with a SOLD OUT ribbon.
    final soldOut = item.isSoldOut;

    return Material(
      color: soldOut
          ? AppColors.surface.withValues(alpha: 0.55)
          : AppColors.surface,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: () async {
          if (soldOut) {
            ScaffoldMessenger.of(context).showSnackBar(SnackBar(
              content: Text('${item.name} is sold out — flip it back in '
                  'Menu editor when restocked.'),
              duration: const Duration(seconds: 2),
            ));
            return;
          }
          // Items that have variants OR modifier groups need the config
          // sheet; simple items just quick-add. We probe the backend on
          // tap — for a clean cache we'd preload, but the wire-up here is
          // fast enough and keeps the menu provider lightweight.
          await showModalBottomSheet(
            context: context,
            isScrollControlled: true,
            backgroundColor: Colors.transparent,
            builder: (_) => ItemConfigSheet(item: item),
          );
        },
        onLongPress: () {
          if (soldOut) return; // 86'd — no quick-add either
          // Long-press = bypass config sheet & quick-add a base line.
          // Useful for staff hammering through identical orders.
          context.read<OrdersProvider>().quickAdd(item);
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text('Added ${item.name}'),
              duration: const Duration(milliseconds: 700),
            ),
          );
        },
        child: Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(14),
            border: Border.all(
              color: qty > 0 ? AppColors.primary : AppColors.divider,
              width: qty > 0 ? 1.5 : 1,
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Container(
                    width: 12, height: 12,
                    decoration: BoxDecoration(
                      border: Border.all(
                        color: item.isVeg ? AppColors.success : AppColors.error,
                        width: 1.5,
                      ),
                    ),
                    child: Center(
                      child: Container(
                        width: 6, height: 6,
                        decoration: BoxDecoration(
                          color: item.isVeg ? AppColors.success : AppColors.error,
                          shape: BoxShape.circle,
                        ),
                      ),
                    ),
                  ),
                  const Spacer(),
                  if (soldOut)
                    Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 6, vertical: 2),
                      decoration: BoxDecoration(
                        color: AppColors.error.withValues(alpha: 0.15),
                        borderRadius: BorderRadius.circular(6),
                      ),
                      child: const Text('SOLD OUT',
                          style: TextStyle(
                            color: AppColors.error,
                            fontWeight: FontWeight.w800,
                            fontSize: 10,
                          )),
                    )
                  // Show "in cart" badge with current qty so the cashier can
                  // see at-a-glance how many of this item are already added.
                  else if (qty > 0)
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                      decoration: BoxDecoration(
                        color: AppColors.primary,
                        borderRadius: BorderRadius.circular(10),
                      ),
                      child: Text('×$qty',
                          style: const TextStyle(
                            color: Colors.white,
                            fontWeight: FontWeight.w800,
                            fontSize: 11,
                          )),
                    )
                  else if (item.isLowStock)
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
              // Item photo (founder feedback 22 Aug): images uploaded in
              // the menu editor now show on the POS tile too. Falls back
              // to the old spacer layout when there's no image.
              if (item.imageUrl != null && item.imageUrl!.isNotEmpty)
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 6),
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(8),
                      // NP-140: CachedNetworkImage — Image.network re-fetched
                      // and decoded the FULL-RES upload for every tile on
                      // every grid rebuild. Disk-cached + decoded at ~2× the
                      // tile's logical width (grid tile ≈ half screen ≈
                      // 180-200 lp) so scrolling stops churning memory.
                      child: CachedNetworkImage(
                        imageUrl: fullImageUrl(item.imageUrl!),
                        width: double.infinity,
                        fit: BoxFit.cover,
                        memCacheWidth: 400,
                        placeholder: (_, __) =>
                            Container(color: AppColors.background),
                        errorWidget: (_, __, ___) => const SizedBox.shrink(),
                      ),
                    ),
                  ),
                )
              else
                const Spacer(),
              Text(
                item.name,
                maxLines: 2, overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontSize: 14, fontWeight: FontWeight.w700,
                  color: AppColors.textPrimary,
                ),
              ),
              const SizedBox(height: 4),
              Row(
                children: [
                  Text(
                    AppFmt.money(item.price),
                    style: const TextStyle(
                      color: AppColors.primary,
                      fontWeight: FontWeight.w700,
                      fontSize: 15,
                    ),
                  ),
                  const Spacer(),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                    decoration: BoxDecoration(
                      color: qty == 0 ? AppColors.primary : AppColors.success,
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Text(qty == 0 ? 'Add' : '+1',
                        style: const TextStyle(
                          color: Colors.white,
                          fontWeight: FontWeight.w700,
                          fontSize: 12,
                        )),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Persistent bottom cart drawer. Tap the header chevron to expand into a
/// full list of every line in the cart with per-line qty steppers + remove.
class _CartPanel extends StatefulWidget {
  const _CartPanel();

  @override
  State<_CartPanel> createState() => _CartPanelState();
}

class _CartPanelState extends State<_CartPanel> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final orders = context.watch<OrdersProvider>();
    final cart = orders.cart;
    final safeBottom = MediaQuery.of(context).viewPadding.bottom;

    return Material(
      elevation: 14,
      color: AppColors.surface,
      child: AnimatedSize(
        duration: const Duration(milliseconds: 220),
        curve: Curves.easeOut,
        child: Padding(
          padding: EdgeInsets.fromLTRB(16, 10, 16, 10 + safeBottom),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // Header — always visible
              InkWell(
                onTap: () => setState(() => _expanded = !_expanded),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 6),
                  child: Row(
                    children: [
                      Container(
                        padding: const EdgeInsets.all(8),
                        decoration: BoxDecoration(
                          color: AppColors.primary.withValues(alpha: 0.12),
                          borderRadius: BorderRadius.circular(10),
                        ),
                        child: Stack(
                          clipBehavior: Clip.none,
                          children: [
                            const Icon(Icons.shopping_cart_rounded,
                                color: AppColors.primary, size: 22),
                            Positioned(
                              right: -6, top: -6,
                              child: Container(
                                padding: const EdgeInsets.all(3),
                                decoration: const BoxDecoration(
                                  color: AppColors.primary,
                                  shape: BoxShape.circle,
                                ),
                                constraints: const BoxConstraints(minWidth: 18, minHeight: 18),
                                child: Center(
                                  child: Text('${cart.length}',
                                      style: const TextStyle(
                                        color: Colors.white,
                                        fontSize: 10,
                                        fontWeight: FontWeight.w800,
                                      )),
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              '${orders.cartItemCount} item${orders.cartItemCount > 1 ? 's' : ''} '
                                  '· ${cart.length} line${cart.length > 1 ? 's' : ''}',
                              style: const TextStyle(
                                fontSize: 12,
                                color: AppColors.textSecondary,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                            Text(
                              AppFmt.money(orders.cartSubtotal, decimals: true),
                              style: const TextStyle(
                                fontWeight: FontWeight.w800,
                                fontSize: 20,
                                color: AppColors.textPrimary,
                              ),
                            ),
                          ],
                        ),
                      ),
                      Icon(_expanded ? Icons.expand_more : Icons.expand_less,
                          color: AppColors.textSecondary),
                    ],
                  ),
                ),
              ),

              // Expanded line items
              if (_expanded) ...[
                const Divider(height: 16),
                ConstrainedBox(
                  constraints: BoxConstraints(
                    maxHeight: MediaQuery.of(context).size.height * 0.45,
                  ),
                  child: ListView.separated(
                    shrinkWrap: true,
                    itemCount: cart.length,
                    separatorBuilder: (_, __) => const Divider(height: 1),
                    itemBuilder: (_, i) => _CartLineRow(line: cart[i]),
                  ),
                ),
                const Divider(height: 16),
              ] else
                const SizedBox(height: 6),

              // CTA
              SizedBox(
                height: 52,
                child: ElevatedButton.icon(
                  icon: const Icon(Icons.arrow_forward_rounded),
                  label: Text('Review & Pay · ${AppFmt.money(orders.cartSubtotal, decimals: true)}',
                      style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w800)),
                  onPressed: () => Navigator.push(
                    context,
                    MaterialPageRoute(builder: (_) => const ConfirmOrderScreen()),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// One line in the expanded cart — name + variant/modifier summary,
/// line total, qty stepper, remove, and a tap-anywhere-to-edit-note.
class _CartLineRow extends StatelessWidget {
  final CartItem line;
  const _CartLineRow({required this.line});

  Future<void> _editNote(BuildContext context) async {
    final ctl = TextEditingController(text: line.note ?? '');
    final n = await showDialog<String?>(
      context: context,
      builder: (_) => AlertDialog(
        title: Text('Note for ${line.item.name}'),
        content: TextField(
          controller: ctl,
          autofocus: true,
          decoration: const InputDecoration(
            hintText: 'e.g. extra spicy, no onion',
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, null),
              child: const Text('Cancel')),
          ElevatedButton(
            onPressed: () => Navigator.pop(context, ctl.text.trim()),
            child: const Text('Save'),
          ),
        ],
      ),
    );
    if (n != null && context.mounted) {
      context.read<OrdersProvider>().setLineNote(line.lineKey, n.isEmpty ? null : n);
    }
  }

  @override
  Widget build(BuildContext context) {
    final orders = context.read<OrdersProvider>();
    return InkWell(
      onTap: () => _editNote(context),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    line.item.name,
                    style: const TextStyle(
                      fontWeight: FontWeight.w700,
                      fontSize: 14,
                      color: AppColors.textPrimary,
                    ),
                  ),
                  if (line.configSummary.isNotEmpty)
                    Text(line.configSummary,
                        style: const TextStyle(
                          color: AppColors.primary,
                          fontSize: 11,
                          fontWeight: FontWeight.w600,
                        )),
                  Text(
                    '${line.qty} × ${AppFmt.money(line.unitPrice)} = '
                        '${AppFmt.money(line.lineTotal, decimals: true)}',
                    style: const TextStyle(
                      color: AppColors.textSecondary,
                      fontSize: 12,
                    ),
                  ),
                  if (line.note != null && line.note!.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Text(
                        '"${line.note}"',
                        style: const TextStyle(
                            color: AppColors.textHint,
                            fontSize: 11,
                            fontStyle: FontStyle.italic),
                      ),
                    )
                  else
                    const Text('Tap to add note',
                        style: TextStyle(
                            fontSize: 10,
                            color: AppColors.textHint,
                            fontStyle: FontStyle.italic)),
                ],
              ),
            ),
            _stepperBtn(Icons.remove_rounded,
                () => orders.decrementLine(line.lineKey)),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8),
              child: Text('${line.qty}',
                  style: const TextStyle(
                      fontWeight: FontWeight.w800, fontSize: 16)),
            ),
            _stepperBtn(Icons.add_rounded,
                () => orders.incrementLine(line.lineKey)),
            const SizedBox(width: 4),
            IconButton(
              tooltip: 'Remove',
              icon: const Icon(Icons.delete_outline_rounded,
                  color: AppColors.error, size: 20),
              onPressed: () => orders.removeLine(line.lineKey),
            ),
          ],
        ),
      ),
    );
  }

  Widget _stepperBtn(IconData icon, VoidCallback onTap) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(8),
      child: Container(
        padding: const EdgeInsets.all(6),
        decoration: BoxDecoration(
          color: AppColors.primary,
          borderRadius: BorderRadius.circular(8),
        ),
        child: Icon(icon, size: 16, color: Colors.white),
      ),
    );
  }
}
