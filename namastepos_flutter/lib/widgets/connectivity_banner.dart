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

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/material.dart';

import '../constants/colors.dart';

class ConnectivityBanner extends StatefulWidget {
  final Widget child;
  const ConnectivityBanner({super.key, required this.child});

  @override
  State<ConnectivityBanner> createState() => _ConnectivityBannerState();
}

class _ConnectivityBannerState extends State<ConnectivityBanner> {
  bool _offline = false;
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
    });
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        AnimatedContainer(
          duration: const Duration(milliseconds: 220),
          height: _offline ? 32 : 0,
          width: double.infinity,
          color: AppColors.error,
          child: _offline
              ? const SafeArea(
                  bottom: false,
                  child: Center(
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(Icons.cloud_off_outlined,
                            size: 16, color: Colors.white),
                        SizedBox(width: 6),
                        Text(
                          "You're offline. Orders will sync when back online.",
                          style: TextStyle(
                            color: Colors.white,
                            fontSize: 12,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ],
                    ),
                  ),
                )
              : const SizedBox.shrink(),
        ),
        Expanded(child: widget.child),
      ],
    );
  }
}
