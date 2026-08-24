// NamastePOS — Mobile KDS / kitchen ticket screen (F5).
//
// Designed for a phone or 8-10" tablet propped at the cooking station.
// Polls /v1/businesses/:id/ops/kot/tickets every 5s. Each ticket shows the
// table/source, the lines, elapsed minutes, and a button to mark it
// "preparing" / "ready" / "served". Marking "ready" pushes a status update
// the captain/cashier sees too.

import 'dart:async';
import 'package:flutter/material.dart';

import '../../constants/colors.dart';
import '../../utils/error_humanizer.dart';
import '../../services/api_service.dart';
import '../../widgets/home_bottom_nav.dart';
import '../../widgets/home_drawer_button.dart';

class KdsScreen extends StatefulWidget {
  final String businessId;
  const KdsScreen({super.key, required this.businessId});

  @override
  State<KdsScreen> createState() => _KdsScreenState();
}

class _KdsScreenState extends State<KdsScreen> {
  List<dynamic> _stations = [];
  List<dynamic> _tickets = [];
  String? _stationId;       // null = all stations
  bool _loading = true;
  Timer? _poll;

  // Backend kot_status enum: pending | in_progress | done | cancelled.
  // Older builds in this file used queued/preparing/ready/served — those
  // never matched real backend data, so every ticket fell into "queued"
  // and the button's null-lookup crashed. Sticking to backend names now.
  // Human labels for the badge — raw enum names like "IN_PROGRESS"
  // looked broken on the card (founder feedback, 22 Aug).
  static const _statusLabels = {
    'pending':     'NEW',
    'in_progress': 'PREPARING',
    'done':        'DONE',
    'cancelled':   'CANCELLED',
  };
  static const _statusColors = {
    'pending':     Colors.amber,
    'in_progress': Colors.blue,
    'done':        Colors.green,
    'cancelled':   Colors.grey,
  };

  @override
  void initState() {
    super.initState();
    _bootstrap();
    _poll = Timer.periodic(const Duration(seconds: 5), (_) => _load());
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _bootstrap() async {
    try {
      _stations = await ApiService.instance.listStations(widget.businessId);
    } catch (_) {/* no stations configured is fine */}
    await _load();
  }

  Future<void> _load() async {
    try {
      _tickets = await ApiService.instance
          .listKotTickets(widget.businessId, stationId: _stationId);
    } catch (_) {/* poll silently */}
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _advance(Map<String, dynamic> t) async {
    final cur = t['status'] as String? ?? 'pending';
    final next = {
      'pending': 'in_progress',
      'in_progress': 'done',
    }[cur];
    if (next == null) return;
    try {
      await ApiService.instance.markKotTicket(
        widget.businessId, t['id'] as String, next);
      await _load();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(humanizeError(e))),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        leading: (ModalRoute.of(context)?.isFirst ?? true) ? const HomeDrawerButton() : null,
        title: const Text('Kitchen — live tickets'),
        backgroundColor: AppColors.primary,
        foregroundColor: Colors.white,
        actions: [
          IconButton(icon: const Icon(Icons.refresh), onPressed: _load),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : Column(
              children: [
                if (_stations.isNotEmpty)
                  SizedBox(
                    height: 44,
                    child: ListView(
                      scrollDirection: Axis.horizontal,
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                      children: [
                        _stationChip(null, 'All'),
                        ..._stations.map((s) {
                          final m = s as Map;
                          return _stationChip(m['id'] as String, m['name'] as String? ?? '?');
                        }),
                      ],
                    ),
                  ),
                Expanded(
                  child: _tickets.isEmpty
                      ? const Center(
                          child: Padding(
                            padding: EdgeInsets.all(32),
                            child: Text(
                              'No tickets right now.\nPolling every 5 seconds…',
                              textAlign: TextAlign.center,
                              style: TextStyle(
                                fontSize: 16, color: Colors.grey,
                              ),
                            ),
                          ),
                        )
                      : GridView.builder(
                          padding: const EdgeInsets.all(10),
                          gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                            // 0.7 was still clipping the "Mark ready"
                            // button on small-screen iPhones — at 220px
                            // wide × 314px tall, header + source line +
                            // even one item row left no room for the 40
                            // px action button. Dropping to 0.6 gives
                            // ~366 px tall cards which fits everything
                            // with breathing room.
                            maxCrossAxisExtent: 220,
                            childAspectRatio: 0.6,
                            crossAxisSpacing: 10,
                            mainAxisSpacing: 10,
                          ),
                          itemCount: _tickets.length,
                          itemBuilder: (_, i) => _ticketCard(_tickets[i] as Map<String, dynamic>),
                        ),
                ),
              ],
            ),
    bottomNavigationBar: const HomeBottomNav(),
    );
  }

  Widget _stationChip(String? id, String label) {
    final selected = id == _stationId;
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: ChoiceChip(
        label: Text(label),
        selected: selected,
        onSelected: (_) {
          setState(() => _stationId = id);
          _load();
        },
        selectedColor: AppColors.primary,
        labelStyle: TextStyle(
            color: selected ? Colors.white : AppColors.textPrimary,
            fontWeight: FontWeight.w700),
      ),
    );
  }

  Widget _ticketCard(Map<String, dynamic> t) {
    final status = (t['status'] as String?) ?? 'pending';
    final items = (t['items'] as List?) ?? [];
    // FF-328 — colour by prep age RELATIVE to the ticket's slowest item.
    // Bug fix (B11): previously used hardcoded 4/8/15 min buckets, which
    // ignored the per-item `prepMinutes` the backend serializes. A KOT
    // whose slowest item takes 20 min shouldn't turn red at 15 min.
    // Buckets now:
    //   green   elapsed < prep         (on track)
    //   amber   prep    ≤ elapsed < 1.5×prep    (approaching)
    //   red     elapsed ≥ 1.5×prep     (late)
    // Fallback to the old buckets when `prepMinutes` is missing (older
    // menu items) so we don't lose the signal entirely.
    final createdRaw0 = t['createdAt'] ?? t['created_at'];
    final createdAt0 = createdRaw0 != null
        ? DateTime.tryParse(createdRaw0.toString()) : null;
    final elapsedMin0 = createdAt0 != null
        ? DateTime.now().difference(createdAt0).inMinutes : 0;
    // Slowest item's prep time (default 0 = unknown → fallback rules).
    int maxPrep = 0;
    for (final it in items) {
      final p = (it is Map)
          ? ((it['prepMinutes'] ?? it['prep_minutes']) as num?)?.toInt()
          : null;
      if (p != null && p > maxPrep) maxPrep = p;
    }
    Color color;
    if (status == 'done' || status == 'cancelled') {
      color = _statusColors[status] ?? Colors.grey;
    } else if (maxPrep > 0) {
      if (elapsedMin0 >= maxPrep * 1.5) {
        color = Colors.red;
      } else if (elapsedMin0 >= maxPrep) {
        color = Colors.orange;
      } else {
        color = Colors.green;
      }
    } else {
      // Fallback (legacy buckets) when prepMinutes isn't populated.
      if (elapsedMin0 >= 15) color = Colors.red;
      else if (elapsedMin0 >= 8) color = Colors.orange;
      else if (elapsedMin0 >= 4) color = Colors.amber;
      else color = Colors.green;
    }
    // Backend serializes camelCase (createdAt). Older code read snake_case
    // (created_at) → always null → elapsed always 0:00.
    final createdRaw = t['createdAt'] ?? t['created_at'];
    final createdAt = createdRaw != null
        ? DateTime.tryParse(createdRaw.toString())
        : null;
    final elapsed = createdAt != null
        ? DateTime.now().difference(createdAt)
        : Duration.zero;

    // P2 (2026-08-22): Semantics wrapper so TalkBack announces the
    // whole ticket in one hit ("Ticket 42, table 5, late, 18 minutes,
    // 3 items"). Without this, screen-reader users hear a jumble of
    // decorative colours and iconography.
    final semanticStatus = color == Colors.red
        ? 'late'
        : color == Colors.orange
            ? 'hot'
            : color == Colors.amber
                ? 'nearly ready'
                : 'on track';
    return Semantics(
      container: true,
      label: 'Kitchen ticket ${t['orderNo'] ?? t['order_no'] ?? ''}. '
          '${_statusLabels[status] ?? status}. $semanticStatus. '
          '${elapsed.inMinutes} minutes elapsed. '
          '${items.length} item${items.length == 1 ? '' : 's'}.',
      child: Container(
      decoration: BoxDecoration(
        color: AppColors.surface,
        border: Border.all(color: color, width: 2),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Header
          Container(
            color: color.withValues(alpha: 0.15),
            padding: const EdgeInsets.all(8),
            // Overflow fix (2026-08-22, founder screenshot): the old row
            // packed 18px order-no + full-enum badge + age label + timer
            // into a ~200px card → "RIGHT OVERFLOWED BY 11 PIXELS".
            // Badge is now Flexible+ellipsis and the timer stays pinned.
            child: Row(
              children: [
                Text('#${t['orderNo'] ?? t['order_no'] ?? '?'}',
                    style: const TextStyle(
                        fontSize: 15, fontWeight: FontWeight.w900)),
                const SizedBox(width: 4),
                Flexible(
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 2),
                    decoration: BoxDecoration(
                      color: color,
                      borderRadius: BorderRadius.circular(4),
                    ),
                    child: Text(
                      _statusLabels[status] ?? status.toUpperCase(),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                          color: Colors.white,
                          fontWeight: FontWeight.w800,
                          fontSize: 9),
                    ),
                  ),
                ),
                const SizedBox(width: 4),
                // P2 fix (2026-08-22): the KOT-age colour alone excluded
                // colour-blind users and printed KDS boards. Add a text
                // label so status is readable without perceiving the hue.
                Text(
                  color == Colors.red
                      ? 'LATE'
                      : color == Colors.orange
                          ? 'HOT'
                          : color == Colors.amber
                              ? 'SOON'
                              : 'OK',
                  style: TextStyle(
                    fontSize: 9, fontWeight: FontWeight.w800, color: color,
                  ),
                ),
                const Spacer(),
                Icon(Icons.timer_outlined, size: 13,
                    color: elapsed.inMinutes > 15 ? AppColors.error : AppColors.textSecondary),
                Text(' ${elapsed.inMinutes}m',
                    style: TextStyle(
                      fontSize: 11, fontWeight: FontWeight.w800,
                      color: elapsed.inMinutes > 15 ? AppColors.error : AppColors.textSecondary,
                    )),
              ],
            ),
          ),
          // Source / table
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
            child: Text(
              [
                if ((t['tableLabel'] ?? t['table_label']) != null)
                  'Table ${t['tableLabel'] ?? t['table_label']}',
                if (t['source'] != null) (t['source'] as String).toUpperCase(),
              ].join(' · '),
              style: const TextStyle(fontSize: 11, color: AppColors.textSecondary),
            ),
          ),
          const Divider(height: 1),
          // Items
          Expanded(
            child: ListView.builder(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              itemCount: items.length,
              itemBuilder: (_, i) {
                final it = items[i] as Map;
                return Padding(
                  padding: const EdgeInsets.symmetric(vertical: 4),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('${it['qty']}×',
                          style: const TextStyle(
                              fontWeight: FontWeight.w900, fontSize: 16)),
                      const SizedBox(width: 6),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(it['name'] as String? ?? '?',
                                style: const TextStyle(
                                    fontSize: 14, fontWeight: FontWeight.w700)),
                            if (it['note'] != null && (it['note'] as String).isNotEmpty)
                              Text('"${it['note']}"',
                                  style: const TextStyle(
                                      fontSize: 11,
                                      fontStyle: FontStyle.italic,
                                      color: AppColors.warning)),
                          ],
                        ),
                      ),
                    ],
                  ),
                );
              },
            ),
          ),
          // Action
          if (status != 'done' && status != 'cancelled')
            Padding(
              padding: const EdgeInsets.all(8),
              child: SizedBox(
                height: 40,
                child: ElevatedButton(
                  style: ElevatedButton.styleFrom(backgroundColor: color),
                  onPressed: () => _advance(t),
                  // Overlap fix (2026-08-22): FittedBox shrinks the label
                  // instead of letting it clip/overlap on narrow cards.
                  child: FittedBox(
                    fit: BoxFit.scaleDown,
                    child: Text(
                      // Matches backend kot_status names. Fallback prevents
                      // crash if a new status ever appears.
                      {
                        'pending':     'Start preparing',
                        'in_progress': 'Mark ready',
                      }[status] ?? 'Advance',
                      maxLines: 1,
                      style: const TextStyle(
                          fontWeight: FontWeight.w800, color: Colors.white),
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
}
