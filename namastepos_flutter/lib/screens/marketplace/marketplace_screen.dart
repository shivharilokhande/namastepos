// Mobile Marketplace — browse addon catalog + activate / cancel.
//
// Backend endpoints used:
//   GET  /v1/addons                                          — public catalog
//   GET  /v1/businesses/:id/addons                           — my active addons
//   POST /v1/businesses/:id/addons/subscribe { slug }        — activate
//   POST /v1/businesses/:id/addons/:slug/confirm-payment     — paid-addon 2nd leg
//   POST /v1/businesses/:id/addons/:slug/cancel              — cancel
//
// Paid addons (2026-09-03): /subscribe no longer activates a paid addon —
// the backend returns { requiresPayment:true, razorpayOrder:{id,amount,
// currency}, keyId } and we open native Razorpay Checkout for that order
// (mirroring the web MarketplacePage). Activation happens only after
// /confirm-payment verifies the signature server-side; a dismissed checkout
// activates nothing. Free addons keep the instant-activate path.
//
// Stays deliberately small: list rows with name + price + a single CTA
// that flips between "Activate" and "Cancel" based on the current state.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:razorpay_flutter/razorpay_flutter.dart';

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
  // Paid-addon checkout state: the slug whose Razorpay checkout is currently
  // open. Handlers use it to confirm/reset; null when no checkout is live.
  String? _payingSlug;
  late final Razorpay _razorpay;

  @override
  void initState() {
    super.initState();
    _razorpay = Razorpay()
      ..on(Razorpay.EVENT_PAYMENT_SUCCESS, _onPaySuccess)
      ..on(Razorpay.EVENT_PAYMENT_ERROR, _onPayError)
      ..on(Razorpay.EVENT_EXTERNAL_WALLET, _onExternalWallet);
    _load();
  }

  @override
  void dispose() {
    // Same rule as BillingScreen: clear() or the native broadcast receiver
    // leaks on Android and crashes the next open.
    _razorpay.clear();
    super.dispose();
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
      final res = await ApiService.instance.subscribeAddon(biz.id, slug);

      // Paid addon → the backend created a one-time Razorpay Order and wrote
      // NO activation row yet. Open native checkout; activation happens in
      // _onPaySuccess via /confirm-payment. (`order`/`key` read defensively
      // alongside the current `razorpayOrder`/`keyId` field names.)
      if (res['requiresPayment'] == true) {
        final order = ((res['razorpayOrder'] ?? res['order']) as Map?)
            ?.cast<String, dynamic>();
        final key = (res['keyId'] ?? order?['key'])?.toString();
        if (order == null || order['id'] == null || key == null || key.isEmpty) {
          _showSnack('Could not start payment — please try again.');
          return; // finally resets _busySlug
        }
        final addonName = _catalog.firstWhere(
          (a) => (a['slug'] ?? '') == slug,
          orElse: () => const {},
        )['name']?.toString();
        _payingSlug = slug; // keep _busySlug set — handlers reset both
        _razorpay.open(<String, dynamic>{
          'key': key,
          'order_id': order['id'],
          'amount': order['amount'],
          'currency': order['currency'] ?? 'INR',
          'name': 'NamastePOS Add-on',
          'description': addonName ?? slug,
          'prefill': {'contact': biz.phone},
        });
        return;
      }

      // Free addon (or no Razorpay configured) → instant activation, as before.
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
    } on ApiException catch (e) {
      if (!mounted) return;
      // 409 = already subscribed. Treat it as success — refresh the UI
      // so the button flips to "Cancel" and stop showing a scary error.
      if (e.statusCode == 409) {
        await _load();
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Already activated')),
        );
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Could not activate: ${e.message}')),
        );
      }
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Could not activate: $e')),
      );
    } finally {
      // Keep the row busy while a checkout modal is up — the payment
      // handlers own the reset in that case.
      if (mounted && _payingSlug == null) setState(() => _busySlug = null);
    }
  }

  // ── Paid-addon Razorpay handlers ─────────────────────────────────────────
  Future<void> _onPaySuccess(PaymentSuccessResponse resp) async {
    final slug = _payingSlug;
    _payingSlug = null;
    if (!mounted) return;
    final biz = context.read<AuthProvider>().business;
    if (slug == null || biz == null) {
      setState(() => _busySlug = null);
      return;
    }
    try {
      // Server-side confirmation: the backend re-verifies the HMAC signature
      // before activating, so a spoofed success event grants nothing.
      await ApiService.instance.confirmAddonPayment(
        biz.id,
        slug,
        razorpayPaymentId: resp.paymentId ?? '',
        razorpayOrderId: resp.orderId ?? '',
        razorpaySignature: resp.signature ?? '',
      );
      if (!mounted) return;
      await context.read<AuthProvider>().refreshPlan();
      await _load();
      _showSnack('Activated $slug');
    } catch (e) {
      _showSnack('Payment received but activation is pending — '
          'pull to refresh in a moment. (${humanizeError(e)})');
    } finally {
      if (mounted) setState(() => _busySlug = null);
    }
  }

  void _onPayError(PaymentFailureResponse resp) {
    _payingSlug = null;
    if (!mounted) return;
    setState(() => _busySlug = null);
    // Dismissed modal isn't an error — keep the snackbar neutral.
    final isCancel = resp.code == Razorpay.PAYMENT_CANCELLED || resp.code == 0;
    _showSnack(isCancel
        ? 'Checkout cancelled — nothing was charged'
        : 'Payment failed: ${resp.message ?? 'unknown error'}');
  }

  void _onExternalWallet(ExternalWalletResponse resp) {
    // PhonePe / GPay handoff — no final result here; the user returns and
    // can refresh. Keep it neutral.
    _showSnack('Opening ${resp.walletName ?? "wallet"}…');
  }

  void _showSnack(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
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
