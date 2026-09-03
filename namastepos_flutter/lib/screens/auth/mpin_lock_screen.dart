// NamastePOS — Owner MPIN lock screen (PhonePe-style quick unlock).
//
// Shown on app launch/resume when the owner has set an MPIN and a recoverable
// session exists. Correct MPIN → silently refreshes the session and drops into
// the app. Too many wrong tries (or "Use another account") → full sign-out.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../providers/auth_provider.dart';
import '../../services/offline_outbox.dart';

class MpinLockScreen extends StatefulWidget {
  const MpinLockScreen({super.key});
  @override
  State<MpinLockScreen> createState() => _MpinLockScreenState();
}

class _MpinLockScreenState extends State<MpinLockScreen> {
  String _pin = '';
  bool _busy = false;
  int _fails = 0;
  static const _maxFails = 5;

  @override
  void initState() {
    super.initState();
    // Review 2026-08-28: load the PERSISTED fail count so relaunching the app
    // can't reset it and brute-force the MPIN in batches of <5.
    context.read<AuthProvider>().mpinFails().then((n) {
      if (mounted) setState(() => _fails = n);
    });
  }

  Future<void> _submit() async {
    if (_pin.length != 4) return;
    setState(() => _busy = true);
    final auth = context.read<AuthProvider>();
    final ok = await auth.unlockWithMpin(_pin);
    if (!mounted) return;
    if (ok) return; // provider flips status → root gate swaps the screen
    _fails = await auth.bumpMpinFails(); // persistent, survives relaunch
    if (!mounted) return;
    setState(() { _pin = ''; _busy = false; });
    if (_fails >= _maxFails) {
      // Forced security sign-out — no dialog here (a confirm prompt would
      // let whoever is brute-forcing the MPIN stall the lockout). Attempt a
      // silent best-effort drain so queued orders aren't lost with the wipe.
      try { await OfflineOutbox().drainOnce(); } catch (_) {}
      await auth.signOutFromLock();
      return;
    }
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text('Wrong MPIN — ${_maxFails - _fails} tries left'),
    ));
  }

  /// NP-104: full sign-out now wipes the local DB + outbox, so if unsent
  /// orders are still queued the user must explicitly choose their fate.
  Future<void> _useAnotherAccount() async {
    final auth = context.read<AuthProvider>();
    int pending = 0;
    try { pending = await OfflineOutbox().activePendingCount(); } catch (_) {}
    if (!mounted) return;
    if (pending == 0) {
      await auth.signOutFromLock();
      return;
    }
    final choice = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Unsent orders'),
        content: Text('$pending unsent order(s) will be discarded — sync now?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, 'cancel'),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, 'discard'),
            child: const Text('Discard and sign out',
                style: TextStyle(color: AppColors.error)),
          ),
          ElevatedButton(
            onPressed: () => Navigator.pop(ctx, 'sync'),
            child: const Text('Sync now'),
          ),
        ],
      ),
    );
    if (!mounted || choice == null || choice == 'cancel') return;
    if (choice == 'discard') {
      await auth.signOutFromLock();
      return;
    }
    // Sync now: drain, then re-check before wiping.
    setState(() => _busy = true);
    try { await OfflineOutbox().drainOnce(); } catch (_) {}
    int left = 0;
    try { left = await OfflineOutbox().activePendingCount(); } catch (_) {}
    if (!mounted) return;
    setState(() => _busy = false);
    if (left == 0) {
      await auth.signOutFromLock();
    } else {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text('$left order(s) still unsent — check your connection and try again'),
      ));
    }
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthProvider>();
    final name = auth.business?.name ?? 'Welcome back';
    final initial = name.isNotEmpty ? name.substring(0, 1).toUpperCase() : 'N';
    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: Column(
          children: [
            const Spacer(),
            CircleAvatar(
              radius: 34,
              backgroundColor: AppColors.primary.withValues(alpha: 0.12),
              child: Text(initial, style: const TextStyle(
                  color: AppColors.primary, fontWeight: FontWeight.w900, fontSize: 28)),
            ),
            const SizedBox(height: 14),
            Text(name, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
            const SizedBox(height: 4),
            const Text('Enter your MPIN to continue',
                style: TextStyle(color: AppColors.textSecondary)),
            const SizedBox(height: 30),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: List.generate(4, (i) => _dot(i < _pin.length)),
            ),
            const SizedBox(height: 26),
            if (_busy) const CircularProgressIndicator(),
            const Spacer(),
            _keypad(),
            TextButton(
              onPressed: _busy ? null : _useAnotherAccount,
              child: const Text('Use another account'),
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }

  Widget _dot(bool filled) => Container(
        margin: const EdgeInsets.symmetric(horizontal: 9),
        width: 16, height: 16,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: filled ? AppColors.primary : Colors.transparent,
          border: Border.all(color: AppColors.primary, width: 2),
        ),
      );

  Widget _keypad() => SizedBox(
        width: 300,
        child: GridView.count(
          shrinkWrap: true,
          crossAxisCount: 3,
          childAspectRatio: 1.5,
          physics: const NeverScrollableScrollPhysics(),
          children: [
            for (var n = 1; n <= 9; n++) _key('$n'),
            const SizedBox.shrink(),
            _key('0'),
            IconButton(
              onPressed: _pin.isEmpty
                  ? null
                  : () => setState(() => _pin = _pin.substring(0, _pin.length - 1)),
              icon: const Icon(Icons.backspace_outlined),
            ),
          ],
        ),
      );

  Widget _key(String d) => Material(
        color: Colors.transparent,
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: _busy ? null : () {
            if (_pin.length >= 4) return;
            setState(() => _pin = _pin + d);
            if (_pin.length == 4) _submit();
          },
          child: Center(child: Text(d,
              style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w700))),
        ),
      );
}
