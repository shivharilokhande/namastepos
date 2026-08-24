// NamastePOS - Aggregator (Zomato, Swiggy) linking.
//
// Rewritten 2026-08-22 (founder): the old screen only saved an API key
// locally and never talked to the backend. The real flow is OTP-based
// merchant linking, which the backend has supported since migration 053:
//   1. Enter the phone registered with Zomato/Swiggy → Send OTP
//      (POST /aggregators/link/start)
//   2. Enter the 6-digit code → Verify (POST /aggregators/link/verify)
//   3. Paste the outlet/restaurant ID from the partner app → Finish
//      (PUT /aggregators — also flips the link session to 'linked')
// Partner-API keys stay available under "Advanced" for when the vendor
// approves direct API access.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../../utils/error_humanizer.dart';

class AggregatorsScreen extends StatefulWidget {
  const AggregatorsScreen({super.key});

  @override
  State<AggregatorsScreen> createState() => _AggregatorsScreenState();
}

class _AggregatorsScreenState extends State<AggregatorsScreen> {
  List<dynamic> _credentials = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final biz = context.read<AuthProvider>().business;
    if (biz == null) {
      setState(() => _loading = false);
      return;
    }
    try {
      final r = await ApiService.instance.dio
          .get('/businesses/${biz.id}/aggregators');
      if (!mounted) return;
      setState(() {
        _credentials = (r.data['credentials'] as List?) ?? [];
        _loading = false;
      });
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  Map<String, dynamic>? _credFor(String provider) {
    for (final c in _credentials) {
      if ((c as Map)['provider'] == provider) {
        return c.cast<String, dynamic>();
      }
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Aggregators')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                _ProviderCard(
                  provider: 'zomato',
                  title: 'Zomato',
                  color: const Color(0xFFE23744),
                  icon: Icons.restaurant_outlined,
                  cred: _credFor('zomato'),
                  onChanged: _load,
                ),
                const SizedBox(height: 12),
                _ProviderCard(
                  provider: 'swiggy',
                  title: 'Swiggy',
                  color: const Color(0xFFF8951B),
                  icon: Icons.motorcycle_outlined,
                  cred: _credFor('swiggy'),
                  onChanged: _load,
                ),
                const SizedBox(height: 16),
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: AppColors.info.withValues(alpha: 0.08),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: const Row(
                    children: [
                      Icon(Icons.info_outline, color: AppColors.info, size: 18),
                      SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          'Once linked, incoming Zomato/Swiggy orders land in '
                          'your Orders tab automatically. You can find your '
                          'outlet / restaurant ID in the partner app.',
                          style: TextStyle(color: AppColors.info, fontSize: 12),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
    );
  }
}

class _ProviderCard extends StatefulWidget {
  final String provider;
  final String title;
  final Color color;
  final IconData icon;
  final Map<String, dynamic>? cred;
  final VoidCallback onChanged;
  const _ProviderCard({
    required this.provider,
    required this.title,
    required this.color,
    required this.icon,
    required this.cred,
    required this.onChanged,
  });

  @override
  State<_ProviderCard> createState() => _ProviderCardState();
}

class _ProviderCardState extends State<_ProviderCard> {
  final _phone = TextEditingController();
  final _code = TextEditingController();
  final _outletId = TextEditingController();
  final _apiKey = TextEditingController();
  String? _sessionId; // set after Send OTP
  bool _verified = false;
  bool _busy = false;

  @override
  void dispose() {
    _phone.dispose();
    _code.dispose();
    _outletId.dispose();
    _apiKey.dispose();
    super.dispose();
  }

  bool get _isLinked =>
      widget.cred != null &&
      (widget.cred!['outlet_id'] ?? widget.cred!['outletId']) != null &&
      '${widget.cred!['outlet_id'] ?? widget.cred!['outletId']}'.isNotEmpty;

  Future<void> _run(Future<void> Function() fn) async {
    setState(() => _busy = true);
    try {
      await fn();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(humanizeError(e)),
            backgroundColor: AppColors.error));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _sendOtp() => _run(() async {
        final biz = context.read<AuthProvider>().business!;
        final r = await ApiService.instance.dio.post(
          '/businesses/${biz.id}/aggregators/link/start',
          data: {
            'provider': widget.provider,
            'phone': _phone.text.trim(),
          },
        );
        if (!mounted) return;
        setState(() => _sessionId = r.data['sessionId'] as String?);
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text('OTP sent to ${_phone.text.trim()} — enter the '
                '6-digit code below.')));
      });

  Future<void> _verify() => _run(() async {
        final biz = context.read<AuthProvider>().business!;
        await ApiService.instance.dio.post(
          '/businesses/${biz.id}/aggregators/link/verify',
          data: {'sessionId': _sessionId, 'code': _code.text.trim()},
        );
        if (!mounted) return;
        setState(() => _verified = true);
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('Phone verified ✓ — now paste your outlet ID '
                'from the partner app.')));
      });

  Future<void> _finishLink() => _run(() async {
        final biz = context.read<AuthProvider>().business!;
        await ApiService.instance.dio.put(
          '/businesses/${biz.id}/aggregators',
          data: {
            'provider': widget.provider,
            'outletId': _outletId.text.trim(),
            if (_apiKey.text.trim().isNotEmpty) 'apiKey': _apiKey.text.trim(),
          },
        );
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text('${widget.title} linked ✓'),
            backgroundColor: AppColors.success));
        widget.onChanged();
      });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.divider),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(
                  color: widget.color.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Icon(widget.icon, color: widget.color),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(widget.title,
                    style: const TextStyle(
                        fontWeight: FontWeight.w800, fontSize: 16)),
              ),
              if (_isLinked)
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  decoration: BoxDecoration(
                    color: AppColors.success.withValues(alpha: 0.14),
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: const Text('LINKED',
                      style: TextStyle(
                          color: AppColors.success,
                          fontWeight: FontWeight.w800,
                          fontSize: 11)),
                ),
            ],
          ),
          const SizedBox(height: 12),
          if (_isLinked) ...[
            Text(
              'Outlet ID: ${widget.cred!['outlet_id'] ?? widget.cred!['outletId']}',
              style: const TextStyle(color: AppColors.textSecondary),
            ),
          ] else ...[
            // Step 1 — phone + Send OTP
            TextField(
              controller: _phone,
              keyboardType: TextInputType.phone,
              enabled: _sessionId == null,
              onChanged: (_) => setState(() {}), // re-enable Send OTP button
              decoration: InputDecoration(
                labelText: 'Phone registered with ${widget.title}',
                isDense: true,
                border: const OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 8),
            if (_sessionId == null)
              Align(
                alignment: Alignment.centerRight,
                child: ElevatedButton(
                  onPressed: _busy || _phone.text.trim().length < 10
                      ? null
                      : _sendOtp,
                  child: const Text('Send OTP'),
                ),
              ),
            // Step 2 — OTP code
            if (_sessionId != null && !_verified) ...[
              TextField(
                controller: _code,
                keyboardType: TextInputType.number,
                maxLength: 6,
                decoration: const InputDecoration(
                  labelText: '6-digit OTP',
                  counterText: '',
                  isDense: true,
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 8),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  TextButton(
                    onPressed: _busy
                        ? null
                        : () => setState(() {
                              _sessionId = null;
                              _code.clear();
                            }),
                    child: const Text('Change number'),
                  ),
                  ElevatedButton(
                    onPressed: _busy ? null : _verify,
                    child: const Text('Verify'),
                  ),
                ],
              ),
            ],
            // Step 3 — outlet id
            if (_verified) ...[
              TextField(
                controller: _outletId,
                decoration: InputDecoration(
                  labelText: '${widget.title} outlet / restaurant ID',
                  helperText: 'Find it in the ${widget.title} partner app',
                  isDense: true,
                  border: const OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 8),
              Align(
                alignment: Alignment.centerRight,
                child: ElevatedButton(
                  onPressed: _busy ? null : _finishLink,
                  child: const Text('Finish linking'),
                ),
              ),
            ],
            // Advanced — Partner API key (optional, for approved partners)
            ExpansionTile(
              tilePadding: EdgeInsets.zero,
              title: const Text('Advanced (Partner API key)',
                  style: TextStyle(
                      fontSize: 13, color: AppColors.textSecondary)),
              children: [
                TextField(
                  controller: _apiKey,
                  obscureText: true,
                  decoration: const InputDecoration(
                    labelText: 'API key (optional)',
                    isDense: true,
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 8),
              ],
            ),
          ],
        ],
      ),
    );
  }
}
