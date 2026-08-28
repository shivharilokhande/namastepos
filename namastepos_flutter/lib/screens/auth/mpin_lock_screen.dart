// NamastePOS — Owner MPIN lock screen (PhonePe-style quick unlock).
//
// Shown on app launch/resume when the owner has set an MPIN and a recoverable
// session exists. Correct MPIN → silently refreshes the session and drops into
// the app. Too many wrong tries (or "Use another account") → full sign-out.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../providers/auth_provider.dart';

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
      await auth.signOutFromLock();
      return;
    }
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text('Wrong MPIN — ${_maxFails - _fails} tries left'),
    ));
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
              onPressed: _busy ? null : () => context.read<AuthProvider>().signOutFromLock(),
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
