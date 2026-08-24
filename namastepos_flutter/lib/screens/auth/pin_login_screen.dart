// NamastePOS — Staff PIN login (Push 14b).
//
// Two-step flow:
//   1. Pick your name from the staff list for this business
//   2. Enter your 4-digit PIN on a number pad
//
// The businessId comes from the device's cached owner session (set by
// AuthProvider.business). On a fresh device with no prior owner login,
// this screen isn't reachable — the user has to sign in via owner
// email/Google first.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';

const _ROLE_LABELS = {
  'staff_manager':  'Manager',
  'staff_captain':  'Captain',
  'staff_waiter':   'Waiter',
  'staff_cashier':  'Cashier',
  'staff_kitchen':  'Kitchen',
  'staff_driver':   'Driver', // M2 (2026-08-23): was missing → raw key shown
};

const _ROLE_COLORS = {
  'staff_manager': AppColors.primary,
  'staff_captain': AppColors.info,
  'staff_waiter':  AppColors.success,
  'staff_cashier': AppColors.warning,
  'staff_kitchen': Color(0xFFE91E63),
};

class PinLoginScreen extends StatefulWidget {
  final String businessId;
  const PinLoginScreen({super.key, required this.businessId});

  @override
  State<PinLoginScreen> createState() => _PinLoginScreenState();
}

class _PinLoginScreenState extends State<PinLoginScreen> {
  bool _loading = true;
  String? _error;
  List<Map<String, dynamic>> _staff = [];
  Map<String, dynamic>? _selected;
  String _pin = '';
  bool _submitting = false;

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    setState(() { _loading = true; _error = null; });
    try {
      final r = await ApiService.instance.staffPicker(widget.businessId);
      if (!mounted) return; // H6 (2026-08-23)
      setState(() => _staff = r.cast<Map<String, dynamic>>());
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _error = e.message);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _submit() async {
    if (_selected == null || _pin.length != 4) return;
    setState(() => _submitting = true);
    final ok = await context.read<AuthProvider>().signInWithPin(
          businessId: widget.businessId,
          userId: _selected!['userId'] as String,
          pin: _pin,
        );
    if (!mounted) return;
    if (ok) {
      // _RootGate already swapped LoginScreen → HomeScreen at the root,
      // but THIS screen + LoginScreen still sit on top of the navigator
      // stack — user would see an endless spinner until they tapped back.
      // Pop everything so the user lands directly on HomeScreen.
      Navigator.of(context).popUntil((r) => r.isFirst);
      return;
    }
    final err = context.read<AuthProvider>().error;
    setState(() { _pin = ''; _submitting = false; });
    if (err != null) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(err)));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(_selected == null ? 'Sign in as staff' : 'Enter PIN'),
        leading: _selected != null
            ? IconButton(
                icon: const Icon(Icons.arrow_back),
                onPressed: () => setState(() { _selected = null; _pin = ''; }),
              )
            : null,
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? _errorState()
              : _selected == null
                  ? _staffPicker()
                  : _pinKeypad(),
    );
  }

  Widget _errorState() => Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Icon(Icons.error_outline, size: 48, color: AppColors.error),
              const SizedBox(height: 12),
              Text(_error ?? '',
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: AppColors.textSecondary)),
              const SizedBox(height: 16),
              OutlinedButton.icon(
                icon: const Icon(Icons.refresh),
                label: const Text('Retry'),
                onPressed: _load,
              ),
            ],
          ),
        ),
      );

  Widget _staffPicker() {
    if (_staff.isEmpty) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(32),
          child: Text(
            'No staff configured for this business yet. Ask the owner to add you.',
            textAlign: TextAlign.center,
            style: TextStyle(color: AppColors.textSecondary),
          ),
        ),
      );
    }
    return ListView.separated(
      itemCount: _staff.length,
      separatorBuilder: (_, __) => const Divider(height: 1),
      itemBuilder: (_, i) {
        final s = _staff[i];
        final role = s['role'] as String? ?? 'staff_cashier';
        final color = _ROLE_COLORS[role] ?? AppColors.textSecondary;
        return ListTile(
          leading: CircleAvatar(
            backgroundColor: color.withValues(alpha: 0.15),
            child: Text(
              ((s['displayName'] as String?) ?? '?').substring(0, 1).toUpperCase(),
              style: TextStyle(color: color, fontWeight: FontWeight.w900),
            ),
          ),
          title: Text(
            (s['displayName'] as String?) ?? '?',
            style: const TextStyle(fontWeight: FontWeight.w800),
          ),
          subtitle: Text(_ROLE_LABELS[role] ?? role,
              style: TextStyle(color: color)),
          trailing: const Icon(Icons.chevron_right),
          onTap: () => setState(() => _selected = s),
        );
      },
    );
  }

  Widget _pinKeypad() {
    return Column(
      children: [
        const SizedBox(height: 24),
        Text((_selected!['displayName'] as String?) ?? '',
            style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w900)),
        Text(_ROLE_LABELS[_selected!['role']] ?? _selected!['role'],
            style: const TextStyle(color: AppColors.textSecondary)),
        const SizedBox(height: 32),
        // PIN dots
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: List.generate(4, (i) => _pinDot(filled: i < _pin.length)),
        ),
        const SizedBox(height: 36),
        // Keypad 3x4
        Expanded(
          child: GridView.count(
            crossAxisCount: 3,
            padding: const EdgeInsets.symmetric(horizontal: 36, vertical: 8),
            childAspectRatio: 1.4,
            children: [
              for (var n = 1; n <= 9; n++) _key('$n'),
              const SizedBox.shrink(),
              _key('0'),
              IconButton(
                onPressed: _pin.isEmpty
                    ? null
                    : () => setState(() => _pin = _pin.substring(0, _pin.length - 1)),
                icon: const Icon(Icons.backspace_outlined, size: 22),
              ),
            ],
          ),
        ),
        if (_submitting)
          const Padding(
            padding: EdgeInsets.only(bottom: 24),
            child: CircularProgressIndicator(),
          ),
      ],
    );
  }

  Widget _pinDot({required bool filled}) => Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8),
        child: Container(
          width: 18,
          height: 18,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: filled ? AppColors.primary : Colors.transparent,
            border: Border.all(color: AppColors.primary, width: 2),
          ),
        ),
      );

  Widget _key(String digit) => Material(
        color: Colors.transparent,
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: _submitting
              ? null
              : () {
                  if (_pin.length >= 4) return;
                  setState(() => _pin = _pin + digit);
                  if (_pin.length == 4) _submit();
                },
          child: Center(
            child: Text(
              digit,
              style: const TextStyle(fontSize: 28, fontWeight: FontWeight.w700),
            ),
          ),
        ),
      );
}
