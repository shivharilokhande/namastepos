// Mobile Marketplace — browse addon catalog + activate / cancel.
//
// Backend endpoints used:
//   GET  /v1/addons                                    — public catalog
//   GET  /v1/businesses/:id/addons                     — my active addons
//   POST /v1/businesses/:id/addons/subscribe { slug }  — activate
//   POST /v1/businesses/:id/addons/:slug/cancel        — cancel
//
// Stays deliberately small: list rows with name + price + a single CTA
// that flips between "Activate" and "Cancel" based on the current state.

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../utils/error_humanizer.dart';
import '../../utils/formatters.dart';
import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../../widgets/home_bottom_nav.dart';
import '../../widgets/home_drawer_button.dart';

class MarketplaceScreen extends StatefulWidget {
  const MarketplaceScreen({super.key});

  @override
  State<MarketplaceScreen> createState() => _MarketplaceScreenState();
}

class _MarketplaceScreenState extends State<MarketplaceScreen> {
  List<Map<String, dynamic>> _catalog = [];
  Set<String> _activeSlugs = {};
  bool _loading = true;
  String? _error;
  String? _busySlug;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() { _loading = true; _error = null; });
    final biz = context.read<AuthProvider>().business;
    if (biz == null) {
      setState(() { _error = 'No active business'; _loading = false; });
      return;
    }
    try {
      final cat = await ApiService.instance.dio.get('/addons');
      final mine = await ApiService.instance.dio
          .get('/businesses/${biz.id}/addons');
      final catalog = ((cat.data['addons'] as List?) ?? const [])
          .cast<Map>()
          .map((m) => m.cast<String, dynamic>())
          .toList();
      // Backend returns { active: [...], history: [...] } (NOT { addons: ... }).
      // Each item in `active` has shape { ..., addon: { slug, name, ... } }.
      // Earlier we read the wrong key, so isActive was always false and a
      // second tap on Activate hit the backend's 409 "already subscribed".
      final activeList = (mine.data['active'] as List?)
                       ?? (mine.data['addons'] as List?)   // back-compat
                       ?? const [];
      final active = activeList
          .cast<Map>()
          .map((m) => (m['addon'] is Map
                        ? (m['addon'] as Map)['slug']
                        : m['slug'])?.toString())
          .where((s) => s != null && s.isNotEmpty)
          .cast<String>()
          .toSet();
      if (!mounted) return; // H6 (2026-08-23)
      setState(() {
        _catalog = catalog;
        _activeSlugs = active;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() { _error = 'Failed to load: $e'; _loading = false; });
    }
  }

  Future<void> _activate(String slug) async {
    final biz = context.read<AuthProvider>().business;
    if (biz == null) return;
    setState(() => _busySlug = slug);
    try {
      await ApiService.instance.dio.post(
        '/businesses/${biz.id}/addons/subscribe',
        data: { 'slug': slug },
      );
      // Refresh plan + addon list so the drawer immediately reflects the
      // newly-granted feature key.
      if (!mounted) return;
      await context.read<AuthProvider>().refreshPlan();
      await _load();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Activated $slug')),
        );
      }
    } catch (e) {
      if (!mounted) return;
      // 409 = already subscribed. Treat it as success — refresh the UI
      // so the button flips to "Cancel" and stop showing a scary error.
      final isConflict = e is DioException && e.response?.statusCode == 409;
      if (isConflict) {
        await _load();
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Already activated')),
        );
      } else {
        final msg = e is DioException
            ? (e.response?.data is Map
                ? (e.response!.data['message']?.toString() ?? e.message ?? 'request failed')
                : (e.message ?? 'request failed'))
            : e.toString();
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Could not activate: $msg')),
        );
      }
    } finally {
      if (mounted) setState(() => _busySlug = null);
    }
  }

  Future<void> _cancel(String slug) async {
    final biz = context.read<AuthProvider>().business;
    if (biz == null) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Cancel "$slug"?'),
        content: const Text(
          'You\'ll lose access to this addon immediately. You can re-activate any time.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Keep')),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Cancel addon', style: TextStyle(color: Colors.red)),
          ),
        ],
      ),
    );
    if (ok != true) return;
    setState(() => _busySlug = slug);
    try {
      await ApiService.instance.dio
          .post('/businesses/${biz.id}/addons/$slug/cancel');
      if (!mounted) return;
      await context.read<AuthProvider>().refreshPlan();
      await _load();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Cancelled $slug')),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text("Couldn't cancel — " + humanizeError(e))),
        );
      }
    } finally {
      if (mounted) setState(() => _busySlug = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        leading: (ModalRoute.of(context)?.isFirst ?? true) ? const HomeDrawerButton() : null,
        title: const Text('Marketplace'),
        actions: [
          IconButton(icon: const Icon(Icons.refresh), onPressed: _load),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Text(_error!))
              : _catalog.isEmpty
                  ? const Center(child: Text('No addons available yet.'))
                  : RefreshIndicator(
                      onRefresh: _load,
                      child: ListView.separated(
                        padding: const EdgeInsets.all(12),
                        itemCount: _catalog.length,
                        separatorBuilder: (_, __) => const SizedBox(height: 10),
                        itemBuilder: (_, i) => _addonCard(_catalog[i]),
                      ),
                    ),
    bottomNavigationBar: const HomeBottomNav(),
    );
  }

  Widget _addonCard(Map<String, dynamic> a) {
    final slug = (a['slug'] ?? '').toString();
    final name = (a['name'] ?? slug).toString();
    final desc = (a['description'] ?? '').toString();
    final priceInr = (a['priceInr'] as num?)?.toDouble() ?? 0;
    final isActive = _activeSlugs.contains(slug);
    final busy = _busySlug == slug;

    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: isActive ? AppColors.success : AppColors.border,
          width: isActive ? 1.5 : 1,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(name,
                    style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16))),
              if (isActive)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: AppColors.success.withValues(alpha: 0.15),
                    borderRadius: BorderRadius.circular(20),
                  ),
                  child: const Text('ACTIVE',
                      style: TextStyle(
                          color: AppColors.success,
                          fontWeight: FontWeight.w800, fontSize: 11)),
                ),
            ],
          ),
          if (desc.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(desc,
                style: const TextStyle(color: AppColors.textSecondary, fontSize: 13)),
          ],
          const SizedBox(height: 10),
          Row(
            children: [
              Text(
                priceInr > 0 ? '${AppFmt.money(priceInr)}/mo' : 'Free',
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
              const Spacer(),
              busy
                  ? const SizedBox(
                      width: 18, height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2))
                  : ElevatedButton(
                      style: ElevatedButton.styleFrom(
                        backgroundColor:
                            isActive ? Colors.white : AppColors.primary,
                        foregroundColor:
                            isActive ? Colors.red : Colors.white,
                        side: isActive
                            ? const BorderSide(color: Colors.red, width: 1)
                            : null,
                      ),
                      onPressed: () =>
                          isActive ? _cancel(slug) : _activate(slug),
                      child: Text(isActive ? 'Cancel' : 'Activate'),
                    ),
            ],
          ),
        ],
      ),
    );
  }
}
