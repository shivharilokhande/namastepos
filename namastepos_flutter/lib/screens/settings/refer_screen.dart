// NamastePOS — Refer & earn (FF-333 mobile side).
// Shows the restaurant's referral code + share link and referral stats.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'package:share_plus/share_plus.dart';

import '../../constants/colors.dart';
import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../../utils/error_humanizer.dart';

class ReferScreen extends StatefulWidget {
  const ReferScreen({super.key});
  @override
  State<ReferScreen> createState() => _ReferScreenState();
}

class _ReferScreenState extends State<ReferScreen> {
  Map<String, dynamic>? _data;
  bool _loading = true;
  String? _error;

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    final biz = context.read<AuthProvider>().business;
    if (biz == null) { setState(() => _loading = false); return; }
    try {
      _data = await ApiService.instance.referral(biz.id);
    } catch (e) {
      _error = humanizeError(e);
    }
    if (mounted) setState(() => _loading = false);
  }

  String get _code => _data?['code']?.toString() ?? '';
  String get _shareUrl => _code.isEmpty ? '' : 'https://app.namastepos.in/register?ref=$_code';
  String get _msg =>
      'I run my restaurant on NamastePOS — GST billing, KOT & reports, works offline. '
      'Sign up with my code $_code and we both get 1 month free: $_shareUrl';

  @override
  Widget build(BuildContext context) {
    final stats = (_data?['stats'] as Map?) ?? const {};
    return Scaffold(
      appBar: AppBar(title: const Text('Refer & earn')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Text(_error!))
              : ListView(padding: const EdgeInsets.all(16), children: [
                  const Text('Invite another restaurant. When they stay active 30 days, you both get 1 month free.',
                      style: TextStyle(color: AppColors.textSecondary)),
                  const SizedBox(height: 20),
                  Card(
                    child: Padding(
                      padding: const EdgeInsets.all(20),
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        const Text('Your referral code', style: TextStyle(color: AppColors.textSecondary, fontSize: 13)),
                        const SizedBox(height: 6),
                        Text(_code.isEmpty ? '…' : _code,
                            style: const TextStyle(fontSize: 30, fontWeight: FontWeight.w800, letterSpacing: 3)),
                        const SizedBox(height: 16),
                        Row(children: [
                          OutlinedButton.icon(
                            onPressed: _code.isEmpty ? null : () {
                              Clipboard.setData(ClipboardData(text: _shareUrl));
                              ScaffoldMessenger.of(context).showSnackBar(
                                  const SnackBar(content: Text('Link copied')));
                            },
                            icon: const Icon(Icons.copy, size: 18),
                            label: const Text('Copy link'),
                          ),
                          const SizedBox(width: 8),
                          FilledButton.icon(
                            onPressed: _code.isEmpty ? null : () => Share.share(_msg),
                            icon: const Icon(Icons.share, size: 18),
                            label: const Text('Share'),
                          ),
                        ]),
                      ]),
                    ),
                  ),
                  const SizedBox(height: 16),
                  Row(children: [
                    _stat('Pending', stats['pending']),
                    _stat('Signed up', stats['signed_up']),
                    _stat('Rewarded', stats['awarded']),
                  ]),
                ]),
    );
  }

  Widget _stat(String label, dynamic n) => Expanded(
        child: Card(
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 16),
            child: Column(children: [
              Text('${n ?? 0}', style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w800)),
              const SizedBox(height: 4),
              Text(label, style: const TextStyle(fontSize: 11, color: AppColors.textSecondary)),
            ]),
          ),
        ),
      );
}
