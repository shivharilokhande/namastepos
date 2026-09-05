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
import '../../constants/feature_keys.dart';
import '../../models/cart_item.dart';
import '../../models/menu_item.dart';
import '../../providers/auth_provider.dart';
import '../../providers/menu_provider.dart';
import '../../providers/orders_provider.dart';
import '../../services/voice_order_service.dart';
import '../../widgets/plan_gate.dart';
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

  // ── MAY THE MIC BE DRAWN? ────────────────────────────────────────────────
  //
  // build() computes `_voiceDeviceReady && voiceEntitled`. BOTH halves must
  // be true, and the entitlement half FAILS CLOSED:
  //
  //   * `Features.voicePos` in the live plan feed — the key the founder
  //     toggles in the admin console, resolved per business by /auth/me
  //     (plan matrix + addon grants + per-business overrides). NEVER a tier
  //     code: the code `pro` is the ENTERPRISE plan, so gating on tiers here
  //     would hand voice to the wrong customers entirely. AuthProvider.has()
  //     returns false while entitlements are unknown, so not-yet-loaded, a
  //     failed fetch, and an absent key all hide the mic.
  //   * the device probe — a recogniser exists and permission is not a dead
  //     end. Never offer a control that cannot work.
  //
  // 2026-09-05: the gate used to be the device probe ALONE. Voice POS was
  // removed from a plan in the admin console and the mic stayed on a paying
  // customer's phone, because nothing in the voice path had ever asked what
  // the business was entitled to.
  //
  // HONEST LIMIT: recognition runs on the device (Android SpeechRecognizer /
  // iOS Speech.framework) with no NamastePOS server anywhere in the path, so
  // there is no request to reject and none of this is enforcement. It is a UI
  // decision made from server-supplied entitlements — what an owner sees, not
  // what a modified client could be stopped from doing.

  /// Whether this DEVICE can do speech at all. Starts false and is turned on
  /// only by a successful, NON-PROMPTING probe — a phone with no speech
  /// recogniser never gets a button that would fail on tap, and merely
  /// opening this screen never raises an OS permission sheet.
  ///
  /// This is HALF the answer; the other half is the entitlement, read live
  /// from the plan feed in [build].
  bool _voiceDeviceReady = false;

  /// Set once a probe has been run, so the entitlement-arrives-late path in
  /// [build] cannot schedule a fresh probe on every frame.
  bool _voiceProbed = false;

  /// True while a listen session is live, so the mic can show it is hot.
  bool _listening = false;

  @override
  void initState() {
    super.initState();
    _probeVoice();
    // Bound how stale an entitlement can be on the ONE screen where a removed
    // feature is most visible to a paying customer. No-op when the plan was
    // fetched in the last couple of minutes. See AuthProvider.refreshPlanIfStale.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      context.read<AuthProvider>().refreshPlanIfStale();
    });
  }

  @override
  void dispose() {
    // Never leave the microphone hot behind a closed screen.
    VoiceOrderService.instance.abort();
    super.dispose();
  }

  Future<void> _probeVoice() async {
    if (!mounted || _voiceProbed) return;
    // Do not even ASK the OS about speech when the plan does not include it —
    // no probe, no permission-state read, no recogniser init for a feature
    // this business is not on. (Entitlements fail closed, so an unresolved
    // plan lands here too; build() retries once /auth/me answers.)
    if (!context.read<AuthProvider>().has(Features.voicePos)) return;
    _voiceProbed = true;
    await VoiceOrderService.instance.probe();
    if (!mounted) return;
    setState(() => _voiceDeviceReady = VoiceOrderService.instance.offerMicButton);
  }

  @override
  Widget build(BuildContext context) {
    final menu = context.watch<MenuProvider>();
    // Watches the plan, so an entitlement that arrives — or is withdrawn —
    // while this screen is open takes the mic with it on the next frame.
    final voiceEntitled = PlanGate.allows(context, Features.voicePos);
    final voiceAllowed = _voiceDeviceReady && voiceEntitled;
    // The entitlement can land AFTER initState (cold start, or the owner just
    // upgraded), in which case initState's probe declined to run. Run it now.
    if (voiceEntitled && !_voiceProbed) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _probeVoice());
    }
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
          if (voiceAllowed)
            // GestureDetector, not just IconButton, so a long-press can open
            // the language picker — an owner whose staff calls out orders in
            // Marathi should not be stuck on the en_IN default.
            GestureDetector(
              onLongPress: _listening ? null : () => _pickVoiceLanguage(context),
              child: IconButton(
                tooltip: 'Voice order (long-press for language)',
                icon: Icon(_listening ? Icons.mic : Icons.mic_rounded,
                    color: _listening ? AppColors.error : null),
                onPressed: _listening ? null : () => _voiceOrder(context),
              ),
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

  /// Voice order: listen → parse → SHOW THE OWNER WHAT WE HEARD → add.
  ///
  /// Nothing reaches the cart without a tap on "Add". Speech recognition on a
  /// Hinglish menu is a good shortcut and a bad oracle: "do chai" is as often
  /// heard as "do chi" or "two chai", and a wrong line here becomes a wrong
  /// bill for a real customer. The confirm sheet is the whole safety story.
  ///
  /// Nothing about the audio, the transcript or the matches is reported to
  /// analytics — see the note at the top of services/voice_order_service.dart.
  Future<void> _voiceOrder(BuildContext context) async {
    final messenger = ScaffoldMessenger.of(context);
    final voice = VoiceOrderService.instance;

    // Belt to build()'s braces. The mic is only drawn when entitled, but an
    // entitlement can be withdrawn between the frame that drew the button and
    // the tap that hits it (refreshPlanIfStale, an app-resume refresh). Never
    // open a microphone for a business that is not on this feature.
    if (!context.read<AuthProvider>().has(Features.voicePos)) {
      if (mounted) setState(() => _voiceDeviceReady = false);
      return;
    }

    // Permission permanently refused: not a dead button — hand them Settings.
    if (voice.needsSettings) {
      messenger.showSnackBar(SnackBar(
        content: Text(VoiceOrderService.messageForReadiness(voice.readiness)),
        duration: const Duration(seconds: 6),
        action: SnackBarAction(
            label: 'Settings', onPressed: () => voice.openSettings()),
      ));
      return;
    }

    setState(() => _listening = true);
    messenger.hideCurrentSnackBar();
    messenger.showSnackBar(const SnackBar(
      content: Text('Listening… say the quantity then the item, '
          'like "do chai" or "two paneer tikka".'),
      duration: Duration(seconds: 8),
    ));

    final text = await voice.listen();

    if (mounted) setState(() => _listening = false);
    messenger.hideCurrentSnackBar();

    // The readiness may have changed under us (a fresh permission prompt, or
    // a phone that turned out to have no recogniser at all). Re-read it so a
    // button that can no longer work stops being drawn.
    if (mounted) {
      setState(() => _voiceDeviceReady = voice.offerMicButton);
    }

    if (text == null || text.trim().isEmpty) {
      messenger.showSnackBar(SnackBar(
        content: Text(voice.lastMessage.isEmpty
            ? 'No speech detected.'
            : voice.lastMessage),
        duration: const Duration(seconds: 5),
        action: voice.needsSettings
            ? SnackBarAction(
                label: 'Settings', onPressed: () => voice.openSettings())
            : null,
      ));
      return;
    }

    // Guard the BuildContext reads below across the listen() async gap.
    if (!context.mounted) return;
    // The WHOLE menu, not `visibleItems` — that getter is narrowed by the
    // category chip the owner happens to have tapped, and a voice order must
    // never be silently scoped to one category. Saying "amul pav bhaji" while
    // the Drinks chip is selected has to reach the pav bhaji.
    final menu = context.read<MenuProvider>().items;
    final parsed = VoiceOrderService.parse(text, menu);

    if (parsed.lines.isEmpty) {
      messenger.showSnackBar(SnackBar(
        content: Text('Heard "$text" but nothing on the menu matches. '
            'Add it from the grid, or try saying just the item name.'),
        duration: const Duration(seconds: 6),
      ));
      return;
    }

    final confirmed = await _confirmVoiceLines(context, text, parsed);
    if (confirmed == null || confirmed.isEmpty) return;
    if (!context.mounted) return;

    final orders = context.read<OrdersProvider>();
    final added = <String>[];
    for (final p in confirmed) {
      // Re-resolve against the live menu: it can be refreshed while the
      // confirm sheet is open, and a stale MenuItem would price wrongly.
      MenuItem? m = p.item;
      for (final x in context.read<MenuProvider>().items) {
        if (x.id == p.item?.id || x.name == p.name) { m = x; break; }
      }
      if (m == null) continue;
      orders.addToCart(CartItem(item: m, qty: p.qty));
      added.add('${p.qty}× ${m.name}');
    }
    if (added.isEmpty) return;
    messenger.showSnackBar(SnackBar(content: Text('Added ${added.join(", ")}')));
  }

  /// The confirm-before-add sheet. Shows the raw transcript (so the owner can
  /// see WHY a line is wrong), every match with an editable quantity, a
  /// warning marker on low-confidence guesses, a FORCED choice wherever two
  /// menu items fit the words equally well, and anything we could not match.
  ///
  /// The rule this sheet exists to enforce: the app may guess out loud, but it
  /// may never guess silently. An ambiguous line starts unticked with nothing
  /// chosen, so "Add to order" cannot carry it until the owner has pointed at
  /// the dish they meant.
  Future<List<ParsedVoiceLine>?> _confirmVoiceLines(
      BuildContext context, String transcript, VoiceParseResult parsed) {
    final qty = <int>[for (final l in parsed.lines) l.qty];
    // Ambiguous lines are OFF until the owner picks one of the candidates.
    final keep = <bool>[for (final l in parsed.lines) !l.ambiguous];
    // Index into line.options. Null on an ambiguous line means "not chosen
    // yet"; 0 everywhere else, where there is only ever one candidate.
    final chosen = <int?>[for (final l in parsed.lines) l.ambiguous ? null : 0];

    return showModalBottomSheet<List<ParsedVoiceLine>>(
      context: context,
      isScrollControlled: true,
      builder: (sheetContext) {
        return StatefulBuilder(
          builder: (innerContext, setSheetState) {
            return SafeArea(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 12),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        const Icon(Icons.mic_rounded, size: 20),
                        const SizedBox(width: 8),
                        const Expanded(
                          child: Text('Check before adding',
                              style: TextStyle(
                                  fontSize: 16, fontWeight: FontWeight.w700)),
                        ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text('Heard: "$transcript"',
                        style: const TextStyle(
                            fontSize: 12,
                            color: AppColors.textSecondary,
                            fontStyle: FontStyle.italic)),
                    const SizedBox(height: 12),
                    // A short list in a bounded box — never a ListView inside
                    // an unbounded column.
                    ConstrainedBox(
                      constraints: BoxConstraints(
                          maxHeight:
                              MediaQuery.of(innerContext).size.height * 0.4),
                      child: SingleChildScrollView(
                        child: Column(
                          children: [
                            for (var i = 0; i < parsed.lines.length; i++)
                              _VoiceLineRow(
                                line: parsed.lines[i],
                                qty: qty[i],
                                keep: keep[i],
                                chosen: chosen[i],
                                onKeep: (v) =>
                                    setSheetState(() => keep[i] = v),
                                onQty: (v) => setSheetState(
                                    () => qty[i] = v.clamp(1, 99)),
                                // Picking a candidate IS the confirmation for
                                // that line — one tap, not two.
                                onChoose: (v) => setSheetState(() {
                                  chosen[i] = v;
                                  keep[i] = true;
                                }),
                              ),
                          ],
                        ),
                      ),
                    ),
                    if (parsed.lines.any((l) => l.ambiguous)) ...[
                      const SizedBox(height: 8),
                      const Text(
                        'Some words fit more than one item. Tap the one you '
                        'meant — nothing is added until you do.',
                        style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w600,
                            color: AppColors.warning),
                      ),
                    ],
                    if (parsed.unmatched.isNotEmpty) ...[
                      const SizedBox(height: 8),
                      Text(
                        'Not on the menu: ${parsed.unmatched.join(", ")}. '
                        'Add these from the grid.',
                        style: const TextStyle(
                            fontSize: 12, color: AppColors.error),
                      ),
                    ],
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        Expanded(
                          child: OutlinedButton(
                            onPressed: () =>
                                Navigator.pop(sheetContext, <ParsedVoiceLine>[]),
                            child: const Text('Cancel'),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: ElevatedButton(
                            onPressed: keep.contains(true)
                                ? () {
                                    final out = <ParsedVoiceLine>[];
                                    for (var i = 0;
                                        i < parsed.lines.length;
                                        i++) {
                                      if (!keep[i]) continue;
                                      final l = parsed.lines[i];
                                      final pick = chosen[i];
                                      // Belt to the checkbox's braces: an
                                      // ambiguous line with nothing chosen
                                      // never reaches the cart.
                                      if (pick == null) continue;
                                      final it = pick < l.options.length
                                          ? l.options[pick]
                                          : l.item;
                                      out.add(ParsedVoiceLine(
                                          it?.name ?? l.name, qty[i],
                                          item: it,
                                          score: l.score,
                                          spoken: l.spoken,
                                          options: l.options));
                                    }
                                    Navigator.pop(sheetContext, out);
                                  }
                                : null,
                            child: const Text('Add to order'),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            );
          },
        );
      },
    );
  }

  /// Long-press on the mic. Lists only the languages the DEVICE reports it can
  /// recognise, so nothing here is a promise the phone cannot keep.
  Future<void> _pickVoiceLanguage(BuildContext context) async {
    final voice = VoiceOrderService.instance;
    final messenger = ScaffoldMessenger.of(context);
    // Same guard as _voiceOrder: a long-press must not initialise the
    // recogniser for a business that no longer has Voice POS.
    if (!context.read<AuthProvider>().has(Features.voicePos)) {
      if (mounted) setState(() => _voiceDeviceReady = false);
      return;
    }
    if (!await voice.init()) {
      if (!context.mounted) return;
      messenger.showSnackBar(SnackBar(
          content:
              Text(VoiceOrderService.messageForReadiness(voice.readiness))));
      if (mounted) setState(() => _voiceDeviceReady = voice.offerMicButton);
      return;
    }
    final locales = voice.selectableLocales;
    if (!context.mounted) return;
    if (locales.isEmpty) {
      messenger.showSnackBar(const SnackBar(
          content: Text('This phone did not report any recognition languages. '
              'The system default will be used.')));
      return;
    }
    final current = voice.localeId;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(16, 16, 16, 4),
              child: Text('Voice language',
                  style:
                      TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
            ),
            const Padding(
              padding: EdgeInsets.fromLTRB(16, 0, 16, 8),
              child: Text(
                'English (India) usually works best for mixed Hindi-English '
                'orders, because item names stay in English letters.',
                style:
                    TextStyle(fontSize: 12, color: AppColors.textSecondary),
              ),
            ),
            Flexible(
              child: ListView.builder(
                shrinkWrap: true,
                itemCount: locales.length,
                itemBuilder: (_, i) {
                  final l = locales[i];
                  return RadioListTile<String>(
                    value: l.id,
                    groupValue: current,
                    title: Text(l.name),
                    subtitle: Text(l.id,
                        style: const TextStyle(fontSize: 11)),
                    onChanged: (v) async {
                      if (v != null) await voice.setLocale(v);
                      if (sheetContext.mounted) Navigator.pop(sheetContext);
                    },
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
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

/// One row in the voice confirm sheet: keep/drop, the matched item, an
/// editable quantity, and — when the match was a guess rather than a hit —
/// what was actually said, so the owner can judge it instead of trusting it.
///
/// Three presentations, in order of how much they demand of the owner:
///   * a confident match reads like an ordinary cart line;
///   * a low-confidence guess is boxed and tinted so it cannot be scrolled
///     past by a thumb moving at POS speed (the previous 14px icon and 11px
///     caption were, in practice, invisible);
///   * an AMBIGUOUS line shows the rival dishes as tappable chips, starts
///     unticked, and cannot be added until one is tapped.
class _VoiceLineRow extends StatelessWidget {
  final ParsedVoiceLine line;
  final int qty;
  final bool keep;

  /// Index into [ParsedVoiceLine.options], or null when the owner has not yet
  /// resolved an ambiguous line.
  final int? chosen;
  final ValueChanged<bool> onKeep;
  final ValueChanged<int> onQty;
  final ValueChanged<int> onChoose;

  const _VoiceLineRow({
    required this.line,
    required this.qty,
    required this.keep,
    required this.chosen,
    required this.onKeep,
    required this.onQty,
    required this.onChoose,
  });

  @override
  Widget build(BuildContext context) {
    final ambiguous = line.ambiguous;
    final picked = (chosen != null && chosen! < line.options.length)
        ? line.options[chosen!]
        : line.item;
    final flagged = ambiguous || !line.confident;

    final row = Row(
      children: [
        Checkbox(
          value: keep,
          // An ambiguous line with nothing chosen has no item to tick.
          onChanged: (ambiguous && chosen == null)
              ? null
              : (v) => onKeep(v ?? false),
        ),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  if (flagged)
                    Padding(
                      padding: const EdgeInsets.only(right: 6),
                      child: Icon(
                        ambiguous
                            ? Icons.help_rounded
                            : Icons.warning_amber_rounded,
                        size: 20,
                        color: ambiguous ? AppColors.warning : AppColors.error,
                      ),
                    ),
                  Flexible(
                    child: Text(
                      ambiguous && chosen == null
                          ? 'Which one? — you said "${line.spoken}"'
                          : (picked?.name ?? line.name),
                      style: const TextStyle(
                          fontWeight: FontWeight.w700, fontSize: 14),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ),
              if (!ambiguous)
                Text(
                  line.confident
                      ? (picked?.price == null
                          ? ''
                          : AppFmt.money(picked!.price))
                      : 'NOT SURE — guessed from "${line.spoken}". '
                          'Check before adding.',
                  style: TextStyle(
                    fontSize: line.confident ? 11 : 12,
                    fontWeight:
                        line.confident ? FontWeight.w400 : FontWeight.w600,
                    color: line.confident
                        ? AppColors.textSecondary
                        : AppColors.error,
                  ),
                ),
            ],
          ),
        ),
        IconButton(
          visualDensity: VisualDensity.compact,
          icon: const Icon(Icons.remove_circle_outline, size: 20),
          onPressed: qty > 1 ? () => onQty(qty - 1) : null,
        ),
        Text('$qty',
            style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
        IconButton(
          visualDensity: VisualDensity.compact,
          icon: const Icon(Icons.add_circle_outline, size: 20),
          onPressed: () => onQty(qty + 1),
        ),
      ],
    );

    if (!flagged) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: row,
      );
    }

    final accent = ambiguous ? AppColors.warning : AppColors.error;
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 6),
      padding: const EdgeInsets.fromLTRB(4, 4, 4, 8),
      decoration: BoxDecoration(
        color: accent.withValues(alpha: 0.08),
        border: Border.all(color: accent.withValues(alpha: 0.55)),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          row,
          if (ambiguous)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 0),
              child: Wrap(
                spacing: 8,
                runSpacing: 4,
                children: [
                  for (var i = 0; i < line.options.length; i++)
                    ChoiceChip(
                      selected: chosen == i,
                      onSelected: (_) => onChoose(i),
                      label: Text(
                        '${line.options[i].name} · '
                        '${AppFmt.money(line.options[i].price)}',
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                          color: chosen == i
                              ? Colors.white
                              : AppColors.textPrimary,
                        ),
                      ),
                      selectedColor: AppColors.primary,
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}
