// NamastePOS — Staff PIN login.
//
// Phone-first flow (2026-08-26) — the owner NO LONGER has to sign in first on
// the staffer's phone:
//   1. Staff enter their own mobile number
//   2. If they belong to >1 restaurant, pick the outlet; otherwise skip
//   3. Enter the 4-digit PIN on a number pad
//
// The mobile number identifies the PERSON; each restaurant they work at is an
// independent membership resolved server-side (POST /auth/staff-resolve), so a
// staffer who works at (or moved between) two NamastePOS restaurants just sees
// an outlet picker — no owner coordination, no "already in use" error.
//
// Legacy shared-device mode: if a [businessId] is passed (e.g. a fixed counter
// tablet bound to one restaurant by a prior owner login), the screen skips the
// phone step and shows that business's staff picker instead.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
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

enum _Step { phone, pickOutlet, pickStaff, pin }

class PinLoginScreen extends StatefulWidget {
  /// Legacy shared-device mode: bind to one restaurant and skip the phone
  /// step. Leave null for the phone-first flow (the default from the login
  /// screen).
  final String? businessId;
  const PinLoginScreen({super.key, this.businessId});

  @override
  State<PinLoginScreen> createState() => _PinLoginScreenState();
}

class _PinLoginScreenState extends State<PinLoginScreen> {
  late _Step _step;
  bool _loading = false;
  String? _error;

  // phone-first
  final _phone = TextEditingController();
  List<Map<String, dynamic>> _outlets = [];

  // legacy shared-device
  List<Map<String, dynamic>> _staff = [];

  // chosen membership → drives the PIN step
  Map<String, dynamic>? _selected;
  String? _businessId; // effective business for signInWithPin
  String _pin = '';
  bool _submitting = false;

  @override
  void initState() {
    super.initState();
    if (widget.businessId != null) {
      _businessId = widget.businessId;
      _step = _Step.pickStaff;
      _loadStaffPicker();
    } else {
      _step = _Step.phone;
    }
  }

  @override
  void dispose() {
    _phone.dispose();
    super.dispose();
  }

  // ── Legacy: staff picker for a bound business ──────────────────────────
  Future<void> _loadStaffPicker() async {
    setState(() { _loading = true; _error = null; });
    try {
      final r = await ApiService.instance.staffPicker(widget.businessId!);
      if (!mounted) return;
      setState(() => _staff = r.cast<Map<String, dynamic>>());
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  // ── Phone-first: resolve outlets for a mobile number ───────────────────
  Future<void> _resolvePhone() async {
    final phone = _phone.text.trim();
    if (phone.length < 8) {
      setState(() => _error = 'Enter your mobile number');
      return;
    }
    setState(() { _loading = true; _error = null; });
    try {
      final r = await ApiService.instance.staffResolve(phone);
      if (!mounted) return;
      final outlets = r.cast<Map<String, dynamic>>();
      if (outlets.isEmpty) {
        setState(() {
          _loading = false;
          _error = 'No staff account found for this number. '
              'Ask the restaurant owner to add you.';
        });
        return;
      }
      if (outlets.length == 1) {
        _choose(outlets.first);
      } else {
        setState(() { _outlets = outlets; _step = _Step.pickOutlet; _loading = false; });
      }
    } on ApiException catch (e) {
      if (mounted) setState(() { _error = e.message; _loading = false; });
    } catch (e) {
      if (mounted) setState(() { _error = e.toString(); _loading = false; });
    }
  }

  void _choose(Map<String, dynamic> membership) {
    setState(() {
      _selected = membership;
      _businessId = membership['businessId'] as String?;
      _pin = '';
      _step = _Step.pin;
      _loading = false;
    });
  }

  Future<void> _submit() async {
    if (_selected == null || _businessId == null || _pin.length != 4) return;
    setState(() => _submitting = true);
    final ok = await context.read<AuthProvider>().signInWithPin(
          businessId: _businessId!,
          userId: _selected!['userId'] as String,
          pin: _pin,
        );
    if (!mounted) return;
    if (ok) {
      Navigator.of(context).popUntil((r) => r.isFirst);
      return;
    }
    final err = context.read<AuthProvider>().error;
    setState(() { _pin = ''; _submitting = false; });
    if (err != null) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(err)));
    }
  }

  void _back() {
    setState(() {
      _error = null;
      _pin = '';
      if (_step == _Step.pin) {
        // Back from PIN → outlet picker if we came from one, else phone/staff.
        if (widget.businessId != null) {
          _selected = null;
          _step = _Step.pickStaff;
        } else if (_outlets.length > 1) {
          _selected = null;
          _step = _Step.pickOutlet;
        } else {
          _selected = null;
          _step = _Step.phone;
        }
      } else if (_step == _Step.pickOutlet) {
        _outlets = [];
        _step = _Step.phone;
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final title = switch (_step) {
      _Step.phone      => 'Sign in as staff',
      _Step.pickOutlet => 'Choose your outlet',
      _Step.pickStaff  => 'Sign in as staff',
      _Step.pin        => 'Enter PIN',
    };
    final showBack = _step == _Step.pin ||
        (_step == _Step.pickOutlet && widget.businessId == null);
    return Scaffold(
      appBar: AppBar(
        title: Text(title),
        leading: showBack
            ? IconButton(icon: const Icon(Icons.arrow_back), onPressed: _back)
            : null,
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : switch (_step) {
              _Step.phone      => _phoneStep(),
              _Step.pickOutlet => _outletPicker(),
              _Step.pickStaff  => _error != null ? _errorState() : _staffPicker(),
              _Step.pin        => _pinKeypad(),
            },
    );
  }

  Widget _phoneStep() {
    return ListView(
      padding: const EdgeInsets.all(24),
      children: [
        const SizedBox(height: 8),
        const Text('Your mobile number',
            style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
        const SizedBox(height: 6),
        const Text(
          'Use the number your owner registered you with. '
          'You don’t need the owner to sign in first.',
          style: TextStyle(color: AppColors.textSecondary, fontSize: 13),
        ),
        const SizedBox(height: 16),
        TextField(
          controller: _phone,
          autofocus: true,
          keyboardType: TextInputType.phone,
          inputFormatters: [
            FilteringTextInputFormatter.allow(RegExp(r'[0-9+\-\s]')),
            LengthLimitingTextInputFormatter(20),
          ],
          onSubmitted: (_) => _resolvePhone(),
          decoration: const InputDecoration(
            prefixIcon: Icon(Icons.phone_outlined),
            hintText: '98765 43210',
            border: OutlineInputBorder(),
          ),
        ),
        if (_error != null) ...[
          const SizedBox(height: 12),
          Text(_error!,
              style: const TextStyle(color: AppColors.error, fontSize: 13)),
        ],
        const SizedBox(height: 20),
        FilledButton(
          onPressed: _resolvePhone,
          child: const Padding(
            padding: EdgeInsets.symmetric(vertical: 12),
            child: Text('Continue'),
          ),
        ),
      ],
    );
  }

  Widget _outletPicker() {
    return ListView.separated(
      itemCount: _outlets.length,
      separatorBuilder: (_, __) => const Divider(height: 1),
      itemBuilder: (_, i) {
        final o = _outlets[i];
        final role = o['role'] as String? ?? 'staff_cashier';
        final color = _ROLE_COLORS[role] ?? AppColors.textSecondary;
        return ListTile(
          leading: CircleAvatar(
            backgroundColor: color.withValues(alpha: 0.15),
            child: const Icon(Icons.storefront_outlined, size: 20),
          ),
          title: Text((o['businessName'] as String?) ?? 'Restaurant',
              style: const TextStyle(fontWeight: FontWeight.w800)),
          subtitle: Text(
            '${(o['displayName'] as String?) ?? ''} · ${_ROLE_LABELS[role] ?? role}',
            style: TextStyle(color: color),
          ),
          trailing: const Icon(Icons.chevron_right),
          onTap: () => _choose(o),
        );
      },
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
                onPressed: _loadStaffPicker,
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
          onTap: () => _choose(s),
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
        Text(
          _selected!['businessName'] != null
              ? '${_selected!['businessName']} · ${_ROLE_LABELS[_selected!['role']] ?? _selected!['role']}'
              : (_ROLE_LABELS[_selected!['role']] ?? _selected!['role'] as String),
          style: const TextStyle(color: AppColors.textSecondary),
        ),
        const SizedBox(height: 32),
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: List.generate(4, (i) => _pinDot(filled: i < _pin.length)),
        ),
        const SizedBox(height: 36),
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
