// NamastePOS mobile — Global network-down banner (FF-219).
//
// Sits at the top of the app shell (wrap MaterialApp.builder). Listens
// on Connectivity().onConnectivityChanged and shows a 32-px red banner
// when the phone loses network. Auto-dismisses when back online.
//
// Why global (not per-screen): a cashier can be looking at any screen
// when the venue Wi-Fi drops. Missing this visual cue leads to lost KOTs
// and confused staff. This is also what OrdersProvider.refresh(),
// OfflineOutbox, and every dio call check against — the banner is the
// human confirmation the UI is not simply stalled.
//
// The banner intentionally uses `SafeArea` and a fixed 32-px height so
// it never covers app-bar controls. Add space via
//     bottom: PreferredSize(preferredSize: Size.fromHeight(32), ...)
// only if the caller wants it inside the AppBar; the default wraps the
// entire Scaffold body.

import 'dart:async';
import 'dart:convert';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/material.dart';

import '../constants/colors.dart';
import '../services/offline_outbox.dart';

class ConnectivityBanner extends StatefulWidget {
  final Widget child;
  const ConnectivityBanner({super.key, required this.child});

  @override
  State<ConnectivityBanner> createState() => _ConnectivityBannerState();
}

class _ConnectivityBannerState extends State<ConnectivityBanner> {
  bool _offline = false;
  // 2026-08-31 review fix: the outbox already dead-letters orders the server
  // rejects, but nothing ever surfaced pendingCount()/deadLetterCount(), so a
  // failed order vanished silently after the cashier printed a KOT + took cash.
  // Poll them and show a pending/FAILED bar the cashier can act on.
  int _pending = 0; // still retrying
  int _failed = 0;  // dead-lettered — need attention
  Timer? _pollTimer;
  // connectivity_plus 7.x emits `List<ConnectivityResult>` (a device may
  // be on Wi-Fi AND mobile at once). We're "offline" only when every
  // transport is `none`.
  StreamSubscription<List<ConnectivityResult>>? _sub;

  @override
  void initState() {
    super.initState();
    _bootstrap();
  }

  bool _isOffline(List<ConnectivityResult> results) =>
      results.isEmpty ||
      results.every((r) => r == ConnectivityResult.none);

  Future<void> _bootstrap() async {
    // Prime with the current state so the banner is correct even before
    // the first change event fires.
    final now = await Connectivity().checkConnectivity();
    if (mounted) setState(() => _offline = _isOffline(now));
    _sub = Connectivity().onConnectivityChanged.listen((r) {
      if (!mounted) return;
      setState(() => _offline = _isOffline(r));
      _refreshCounts();
    });
    await _refreshCounts();
    _pollTimer = Timer.periodic(const Duration(seconds: 10), (_) => _refreshCounts());
  }

  Future<void> _refreshCounts() async {
    try {
      final pending = await OfflineOutbox().activePendingCount();
      final failed = await OfflineOutbox().deadLetterCount();
      if (mounted) setState(() { _pending = pending; _failed = failed; });
    } catch (_) { /* outbox not ready yet — ignore */ }
  }

  Future<void> _openFailedSheet() async {
    final rows = await OfflineOutbox().deadLetters();
    if (!mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // NP-103: count badge — status updates dead-letter here too now,
              // so the header counts every stuck item, not just orders.
              Row(children: [
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 2),
                  decoration: BoxDecoration(
                    color: AppColors.error,
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Text('${rows.length}',
                      style: const TextStyle(
                          color: Colors.white, fontSize: 14, fontWeight: FontWeight.w900)),
                ),
                const SizedBox(width: 8),
                const Expanded(
                  child: Text('item(s) failed to sync',
                      style: TextStyle(fontSize: 18, fontWeight: FontWeight.w900)),
                ),
              ]),
              const SizedBox(height: 4),
              const Text('These never reached the server. Retry when back online, '
                  'or discard if already handled.',
                  style: TextStyle(fontSize: 12, color: Colors.grey)),
              const SizedBox(height: 12),
              Flexible(
                child: ListView(
                  shrinkWrap: true,
                  children: [
                    for (final r in rows)
                      ListTile(
                        dense: true,
                        title: Text(_describe(r), maxLines: 1, overflow: TextOverflow.ellipsis),
                        subtitle: Text('${r['last_error'] ?? ''}',
                            maxLines: 2, overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontSize: 11)),
                        trailing: IconButton(
                          icon: const Icon(Icons.delete_outline, color: AppColors.error),
                          tooltip: 'Discard',
                          onPressed: () async {
                            await OfflineOutbox().discard(r['client_id'] as String);
                            if (ctx.mounted) Navigator.pop(ctx);
                            await _refreshCounts();
                          },
                        ),
                      ),
                  ],
                ),
              ),
              const SizedBox(height: 8),
              Row(children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: () => Navigator.pop(ctx),
                    child: const Text('Close'),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: ElevatedButton.icon(
                    icon: const Icon(Icons.refresh, size: 18),
                    onPressed: () async {
                      await OfflineOutbox().retryDeadLetters();
                      if (ctx.mounted) Navigator.pop(ctx);
                      await _refreshCounts();
                    },
                    label: const Text('Retry all'),
                  ),
                ),
              ]),
            ],
          ),
        ),
      ),
    );
  }

  String _describe(Map<String, dynamic> row) {
    try {
      final body = jsonDecode(row['body'] as String) as Map<String, dynamic>;
      // NP-103: a dead-lettered row can be a status update, not just a create.
      final endpoint = row['endpoint'] as String? ?? '';
      if (endpoint.endsWith('/status')) {
        return 'Status update → ${body['status'] ?? '?'}';
      }
      final items = (body['items'] as List?)?.length ?? 0;
      final total = body['total'] ?? body['tax'] ?? '';
      return 'Order · $items item(s)${total != '' ? ' · ₹$total' : ''}';
    } catch (_) {
      return '${row['method']} ${row['endpoint']}';
    }
  }

  @override
  void dispose() {
    _sub?.cancel();
    _pollTimer?.cancel();
    super.dispose();
  }

  Widget _bar({required Color color, required IconData icon, required String text, VoidCallback? onTap}) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        height: 32,
        width: double.infinity,
        color: color,
        child: SafeArea(
          bottom: false,
          child: Center(
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(icon, size: 16, color: Colors.white),
                const SizedBox(width: 6),
                Text(text,
                    style: const TextStyle(
                        color: Colors.white, fontSize: 12, fontWeight: FontWeight.w700)),
                if (onTap != null) ...[
                  const SizedBox(width: 6),
                  const Icon(Icons.chevron_right, size: 16, color: Colors.white),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    // Priority: a hard sync FAILURE (money already taken, order lost) is the
    // most urgent, then being offline, then a benign "syncing" indicator.
    Widget banner;
    if (_failed > 0) {
      banner = _bar(
        color: AppColors.error,
        icon: Icons.error_outline,
        text: '$_failed item(s) failed to sync — tap to review',
        onTap: _openFailedSheet,
      );
    } else if (_offline) {
      banner = _bar(
        color: AppColors.error,
        icon: Icons.cloud_off_outlined,
        text: "You're offline. Orders will sync when back online."
            '${_pending > 0 ? ' ($_pending queued)' : ''}',
      );
    } else if (_pending > 0) {
      banner = _bar(
        color: AppColors.warning,
        icon: Icons.sync,
        text: 'Syncing $_pending order(s)…',
      );
    } else {
      banner = const SizedBox.shrink();
    }
    return Column(
      children: [
        AnimatedSize(
          duration: const Duration(milliseconds: 220),
          child: banner,
        ),
        Expanded(child: widget.child),
      ],
    );
  }
}
