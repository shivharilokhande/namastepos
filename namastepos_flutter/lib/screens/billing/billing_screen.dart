// NamastePOS — Billing & plan upgrade screen (Push 2 + Push 9 Razorpay SDK).
//
// Shows current tier on top, then a comparison of Starter / Pro /
// Enterprise side-by-side. "Upgrade" buttons kick off the Razorpay
// subscription checkout flow via the official razorpay_flutter SDK —
// native UI on iOS + Android, full UPI/cards/netbanking, no webview.
//
// Backend round-trip:
//   1. POST /billing/change { tier: legacyTier } → returns
//      { subscriptionId, razorpayKeyId, checkoutOptions: {...} }
//   2. Razorpay().open(checkoutOptions) → native modal
//   3. Razorpay fires EVENT_PAYMENT_SUCCESS (or _ERROR / _EXTERNAL_WALLET)
//   4. Backend gets subscription.charged webhook → updates DB
//   5. We hit refreshPlan() on AuthProvider so the UI catches up
//
// We don't manually verify the payment signature on the client — the
// Razorpay webhook is the source of truth, and AuthProvider re-reads the
// plan from the server. Client-side EVENT_PAYMENT_SUCCESS is just the
// UI trigger; trust = webhook + server refresh.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:razorpay_flutter/razorpay_flutter.dart';

import '../../constants/colors.dart';
import '../../providers/auth_provider.dart';
import '../../utils/formatters.dart';
import '../../providers/subscription_provider.dart';
import '../../services/api_service.dart';
import '../../widgets/home_bottom_nav.dart';
import '../../widgets/home_drawer_button.dart';

class BillingScreen extends StatefulWidget {
  const BillingScreen({super.key});

  @override
  State<BillingScreen> createState() => _BillingScreenState();
}

class _BillingScreenState extends State<BillingScreen> {
  Map<String, dynamic>? _sub;
  bool _loading = true;
  bool _checkoutBusy = false;
  // 2026-08-24: monthly/yearly toggle. Backend returns priceYearlyInr per plan
  // and accepts billingPeriod on /billing/change; the app used to ignore both.
  String _billingPeriod = 'monthly';
  late final Razorpay _razorpay;
  // Tier that the user just clicked Upgrade on — used by the success handler
  // to label snackbars and pick which plan to refresh into. Cleared after
  // either success or error fires.
  String? _pendingTier;

  // Push 14f — plans + features are pulled from the backend's /plans
  // endpoint, which returns each plan enriched with featureKeys from the
  // plan_features matrix. The super-admin Plans page is the single
  // source of truth; this list rebuilds on every BillingScreen open.
  List<Map<String, dynamic>> _tiers = const [];
  List<dynamic> _rawPlans = const []; // cached so the yearly toggle can remap

  static const _tierColors = <String, Color>{
    'starter': Color(0xFF10B981),
    'pro': AppColors.primary,
    'enterprise': Color(0xFF7C3AED),
  };
  static const _tierTaglines = <String, String>{
    'starter': 'Cart / Street vendor',
    'pro': 'Cafe / Small restaurant',
    'enterprise': 'Hotel / Chain / Multi-outlet',
  };
  // Readable labels for raw feature keys. Anything unmapped falls back
  // to a humanised key, so new super-admin features still surface.
  static const _featureLabels = <String, String>{
    'pos': 'POS / new order',
    'orders': 'Orders list',
    'token_generation': 'Token generation',
    'tables_single_floor': '1 floor of tables',
    'tables_multi_floor': 'Multi-floor + drag layout',
    'menu_basic': 'Basic menu',
    'menu_variants_modifiers': 'Variants + modifier groups',
    'reports_basic': 'Daily + monthly reports',
    'expenses': 'Expenses tracking',
    'invoice_basic': 'GST invoices',
    'b2b_invoice': 'B2B / GST invoices',
    'staff_lite': 'Staff (PIN logins)',
    'staff_unlimited': 'Unlimited staff accounts',
    'customers_basic': 'Customer directory',
    'customers_crm': 'CRM with notes',
    'loyalty': 'Loyalty points',
    'memberships': 'Memberships',
    'reviews': 'Customer reviews',
    'reservations': 'Reservations',
    'wastage': 'Wastage tracking',
    'daily_closing': 'Daily closing',
    'kds': 'Kitchen display (KDS)',
    'captain_mode': 'Captain mode',
    'driver_mode': 'Driver / delivery',
    'aggregators': 'Aggregators (Zomato/Swiggy)',
    'qr_ordering': 'QR ordering',
    'whatsapp_marketing': 'WhatsApp marketing',
    'recipe_costing': 'Recipe costing',
    'voice_pos': 'Voice POS',
    'bill_split': 'Bill split',
    'surge_pricing': 'Surge pricing',
    'marketplace_addons': 'Marketplace add-ons',
    'multi_outlet': 'Multi-outlet management',
    'accounting_pnl_bs': 'P&L · Balance Sheet · TB',
    'einvoice_gst': 'GST e-invoice (IRN)',
    'recurring_invoices': 'Recurring invoices',
    'bank_reconcile': 'Bank reconciliation',
    'heat_map': 'Heat map',
    'forecast': 'Forecasting',
    'dead_stock': 'Dead-stock analytics',
    'bulk_import': 'Bulk import',
    'api_access': 'API access',
    'white_label': 'White-label',
    'tds_tcs': 'TDS / TCS',
    'multi_currency_fx': 'Multi-currency / FX',
  };

  Map<String, dynamic> _planToTier(Map<String, dynamic> p) {
    final tierKind = (p['tierKind'] as String?) ?? 'starter';
    final priceInr = (p['priceInr'] as num?)?.toDouble() ?? 0;
    // Yearly price: backend sends priceYearlyInr (defaults to 10× monthly when
    // unset). When the toggle is on yearly, show that price + "per year".
    final yearly = _billingPeriod == 'yearly';
    final priceYearlyInr = (p['priceYearlyInr'] as num?)?.toDouble()
        ?? (priceInr > 0 ? priceInr * 10 : 0);
    final shownPrice = yearly ? priceYearlyInr : priceInr;
    final featureKeys = ((p['featureKeys'] as List?) ?? const [])
        .map((e) => e.toString())
        .toList();
    // Fallback (2026-08-22): if the plan_features matrix has no rows for
    // this plan (fresh install / pending migration), fall back to the
    // plan row's JSONB features template so the cards never render empty.
    if (featureKeys.isEmpty) {
      final fmap = (p['features'] as Map?) ?? const {};
      featureKeys.addAll(fmap.entries
          .where((e) => e.value == true)
          .map((e) => e.key.toString()));
    }
    final features = featureKeys
        .map((k) => _featureLabels[k] ?? k.replaceAll('_', ' '))
        .toList();
    return {
      'kind': tierKind,
      'tier': p['tier'],   // legacy enum, used by /billing/change
      'label': p['name'] ?? tierKind,
      'tagline': _tierTaglines[tierKind] ?? '',
      'price': AppFmt.money(shownPrice),
      'priceValue': shownPrice, // numeric, for sorting (display string is grouped)
      'period': shownPrice > 0 ? (yearly ? 'per year' : 'per month') : 'forever',
      'color': _tierColors[tierKind] ?? AppColors.primary,
      // Mark the cheapest paid plan as recommended for the badge.
      'recommended': false,
      'features': features,
    };
  }

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
    // Razorpay instance must be cleared or you leak the native broadcast
    // receiver on Android and crash on the next BillingScreen open.
    _razorpay.clear();
    super.dispose();
  }

  Future<void> _load() async {
    final biz = context.read<AuthProvider>().business;
    if (biz == null) { setState(() => _loading = false); return; }
    try {
      _sub = await ApiService.instance.getSubscription(biz.id);
    } catch (e) {
      // Don't blow up the whole screen; just leave _sub null so the
      // "current plan" banner falls back to the tier label from
      // AuthProvider.plan. Surface the error in debug builds so it shows
      // up in the flutter run console instead of disappearing silently.
      debugPrint('BillingScreen: getSubscription failed: $e');
      _sub = null;
    }
    // Push 14f — pull live plans from the backend. Each plan carries its
    // tier_kind + featureKeys so the compare cards reflect exactly what
    // the super-admin configured (no hardcoded marketing copy).
    try {
      _rawPlans = await ApiService.instance.listPlans();
      _rebuildTiers();
    } catch (e) {
      debugPrint('BillingScreen: listPlans failed: $e');
    }
    if (mounted) setState(() => _loading = false);
  }

  // Map the cached raw plans → display tiers using the current _billingPeriod,
  // so the monthly/yearly toggle re-prices the cards without a server refetch.
  void _rebuildTiers() {
    final tiers = _rawPlans
        .map((p) => _planToTier((p as Map).cast<String, dynamic>()))
        .toList()
      ..sort((a, b) {
        double priceOf(Map<String, dynamic> m) =>
            ((m['priceValue'] as num?) ?? 0).toDouble();
        return priceOf(a).compareTo(priceOf(b));
      });
    for (final t in tiers) {
      final p = ((t['priceValue'] as num?) ?? 0).toDouble();
      if (p > 0) { t['recommended'] = true; break; }
    }
    _tiers = tiers;
  }

  Future<void> _upgrade(String tierKind) async {
    if (tierKind == 'starter') return;        // can't "buy" the free tier
    final biz = context.read<AuthProvider>().business;
    if (biz == null) return;
    if (_checkoutBusy) return;                // double-tap guard

    setState(() { _checkoutBusy = true; _pendingTier = tierKind; });
    try {
      final res = await ApiService.instance
          .changePlan(biz.id, tierKind, billingPeriod: _billingPeriod);
      // Lint fix (2026-08-25): everything below touches `context` after the
      // await — bail if the screen was disposed while the API call ran.
      if (!mounted) return;
      // Manual activation path (2026-08-24): when the backend has no Razorpay
      // keys configured it activates the plan immediately and returns
      // {manual:true, subscription} instead of Razorpay checkoutOptions. Treat
      // that as an instant upgrade rather than erroring on a missing checkout.
      if (res['manual'] == true || res['checkoutOptions'] == null && res['subscription'] != null) {
        final auth = context.read<AuthProvider>();
        final subs = context.read<SubscriptionProvider>();
        await auth.refreshPlan();
        await subs.load(biz.id);
        await _load();
        if (mounted) {
          setState(() { _checkoutBusy = false; _pendingTier = null; });
          // X2 proration — surface the pro-rated charge for the unused
          // remainder of the current cycle, if any.
          final prorate = (res['prorationInr'] as num?)?.toDouble() ?? 0;
          _showSnack(prorate > 0
              ? 'Upgraded — ₹${prorate.toStringAsFixed(0)} charged now for the rest of this cycle'
              : 'You\'re on the ${_currentTierLabel()} plan now');
        }
        return;
      }
      final co = (res['checkoutOptions'] as Map?)?.cast<String, dynamic>();
      if (co == null || co['subscription_id'] == null || co['key'] == null) {
        throw const FormatException(
            'Backend did not return a valid Razorpay subscription. '
            'Is RAZORPAY_KEY_ID set and razorpay plans synced?');
      }
      // Bug #14 (2026-08-25) — RBI e-mandate disclosure. The native Razorpay
      // modal below authorises a RECURRING autopay mandate (UPI Autopay /
      // card autopay), not a one-off charge, and RBI rules require explicit
      // informed consent BEFORE the mandate is set up. Deliberately placed
      // AFTER the manual-activation early-return above and AFTER the `co`
      // validation, so the popup only ever appears when the Razorpay
      // checkout will actually open (free tier / no-Razorpay installs never
      // see it). Pull real plan name + price + cadence from the tier card
      // data, which _rebuildTiers() already prices for _billingPeriod.
      final tierInfo = _tiers.firstWhere(
        (t) => t['kind'] == tierKind,
        orElse: () => <String, dynamic>{},
      );
      final planLabel = (tierInfo['label'] as String?) ?? tierKind;
      final priceLabel = (tierInfo['price'] as String?) ?? '';
      final cadenceWord = _billingPeriod == 'yearly' ? 'year' : 'month';
      if (!mounted) return;
      final agreed = await showDialog<bool>(
        context: context,
        // Force a deliberate choice — tapping outside must not be read as
        // consent, and RBI disclosure shouldn't be dismissible by accident.
        barrierDismissible: false,
        builder: (ctx) => AlertDialog(
          title: const Text('Auto-pay setup'),
          content: Text(
            'You are setting up automatic recurring payment for the '
            '$planLabel plan ($priceLabel/$cadenceWord). Your payment method '
            'will be charged automatically each billing cycle. You can '
            'cancel anytime from Plans & Billing — no questions asked.',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: const Text('Cancel'),
            ),
            ElevatedButton(
              onPressed: () => Navigator.of(ctx).pop(true),
              child: const Text('Agree & Continue'),
            ),
          ],
        ),
      );
      // Anything short of an explicit "Agree & Continue" aborts checkout —
      // no mandate is created, mirroring a Razorpay modal dismiss.
      if (agreed != true) {
        if (mounted) {
          setState(() { _checkoutBusy = false; _pendingTier = null; });
          _showSnack('Checkout cancelled');
        }
        return;
      }
      // razorpay_flutter wants a Map<String, dynamic>. Pass through the
      // backend's options unchanged so any future fields (notes, theme,
      // prefill) propagate without code changes here.
      _razorpay.open(Map<String, dynamic>.from(co));
    } on ApiException catch (e) {
      // 401 → session expired and the refresh interceptor couldn't recover.
      // Force a clean re-login (auth_provider.logout clears tokens, _RootGate
      // swaps to LoginScreen). Avoids the confusing "Invalid or expired
      // token" toast that just sits there with no fix.
      if (e.statusCode == 401) {
        _showSnack('Session expired — please sign in again to upgrade');
        setState(() { _checkoutBusy = false; _pendingTier = null; });
        await Future.delayed(const Duration(milliseconds: 600));
        if (!mounted) return;
        await context.read<AuthProvider>().logout();
        return;
      }
      _showSnack('Couldn\'t start checkout: ${e.message}');
      setState(() { _checkoutBusy = false; _pendingTier = null; });
    } catch (e) {
      _showSnack('Couldn\'t start checkout: $e');
      setState(() { _checkoutBusy = false; _pendingTier = null; });
    }
  }

  void _onPaySuccess(PaymentSuccessResponse resp) async {
    // The webhook is the source of truth — it'll move the subscription to
    // active, create the invoice + payment rows, and update plan_features
    // resolution. We just nudge the AuthProvider to re-read so the UI
    // catches up. ALSO reload SubscriptionProvider so the trial banner
    // (which reads from subscription, not plan) clears immediately — was
    // sticking around with "X days left in trial" even after upgrade.
    _showSnack('Payment received. Activating $_pendingTier plan…');
    final biz = context.read<AuthProvider>().business;
    final auth = context.read<AuthProvider>();
    final subs = context.read<SubscriptionProvider>();
    await auth.refreshPlan();
    if (biz != null) {
      await subs.load(biz.id);
    }
    await _load();
    if (mounted) {
      setState(() { _checkoutBusy = false; _pendingTier = null; });
      _showSnack('You\'re on the ${_currentTierLabel()} plan now');
    }
  }

  void _onPayError(PaymentFailureResponse resp) {
    final reason = resp.message ?? 'Unknown error';
    final code = resp.code;
    if (mounted) {
      setState(() { _checkoutBusy = false; _pendingTier = null; });
      // Code 0 / 1 are common "user dismissed modal" results — those don't
      // need an alarming red toast, just a quiet "you cancelled".
      final isCancel = code == Razorpay.PAYMENT_CANCELLED || code == 0;
      _showSnack(isCancel ? 'Checkout cancelled' : 'Payment failed: $reason');
    }
  }

  void _onExternalWallet(ExternalWalletResponse resp) {
    // E.g. PhonePe / GPay handoff. We don't get a final result here; the
    // webhook + AuthProvider.refreshPlan() will tell us if it went through.
    _showSnack('Opening ${resp.walletName ?? "wallet"}…');
  }

  void _showSnack(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  String _currentTierLabel() {
    final t = context.read<AuthProvider>().plan.tierKind;
    // Bug fix: when _tiers is empty (initial state OR listPlans failed),
    // _tiers.first inside orElse throws StateError. Guard explicitly.
    if (_tiers.isEmpty) return t;
    for (final x in _tiers) {
      if (x['kind'] == t) return (x['label'] as String?) ?? t;
    }
    return (_tiers.first['label'] as String?) ?? t;
  }

  /// Safely formats `current_period_end` from a `/billing` response. The
  /// backend serialises it as an ISO timestamp string, but old rows / edge
  /// cases may return null, a Date object, or a non-ISO format. Returns null
  /// if we can't parse it cleanly so the caller hides the "Renews …" line
  /// entirely rather than printing "Renews —".
  String? _renewsDate(Map<String, dynamic> sub) {
    final raw = sub['current_period_end'] ??
        sub['currentPeriodEnd']; // camelCase from newer serialisers
    if (raw == null) return null;
    final dt = DateTime.tryParse(raw.toString());
    if (dt == null) return null;
    return dt.toIso8601String().substring(0, 10); // YYYY-MM-DD
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthProvider>();
    final current = auth.plan.tierKind;

    return Scaffold(
      appBar: AppBar(
        leading: (ModalRoute.of(context)?.isFirst ?? true) ? const HomeDrawerButton() : null,
        title: const Text('Plans & billing'),
        actions: [
          IconButton(
            tooltip: 'Refresh plan from server',
            icon: const Icon(Icons.refresh),
            onPressed: () async {
              final messenger = ScaffoldMessenger.of(context);
              await context.read<AuthProvider>().refreshPlan();
              await _load();
              if (mounted) {
                messenger.showSnackBar(
                  const SnackBar(content: Text('Plan synced'))
                );
              }
            },
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                Container(
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(
                    gradient: const LinearGradient(
                      colors: [AppColors.primary, AppColors.primaryLight],
                    ),
                    borderRadius: BorderRadius.circular(14),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('YOU ARE ON',
                          style: TextStyle(
                              color: Colors.white70,
                              fontSize: 11,
                              fontWeight: FontWeight.w800,
                              letterSpacing: 0.6)),
                      const SizedBox(height: 4),
                      Text(
                          (_tiers.firstWhere(
                              (t) => t['kind'] == current,
                              orElse: () => {'label': current})
                            ['label'] as String?) ?? current,
                          style: const TextStyle(
                              color: Colors.white,
                              fontSize: 28,
                              fontWeight: FontWeight.w900)),
                      if (_sub != null && _renewsDate(_sub!) != null)
                        Text(
                          'Renews ${_renewsDate(_sub!)}',
                          style: const TextStyle(color: Colors.white70, fontSize: 12),
                        ),
                    ],
                  ),
                ),
                const SizedBox(height: 20),
                const Text('Compare plans',
                    style: TextStyle(fontWeight: FontWeight.w900, fontSize: 18)),
                const SizedBox(height: 12),
                // Monthly / Yearly toggle (2026-08-24).
                Center(
                  child: SegmentedButton<String>(
                    segments: const [
                      ButtonSegment(value: 'monthly', label: Text('Monthly')),
                      ButtonSegment(value: 'yearly', label: Text('Yearly · save ~2 months')),
                    ],
                    selected: {_billingPeriod},
                    onSelectionChanged: (s) {
                      setState(() {
                        _billingPeriod = s.first;
                        _rebuildTiers(); // re-price the cards from cached plans
                      });
                    },
                  ),
                ),
                const SizedBox(height: 12),
                for (final t in _tiers) _planCard(t, currentTier: current),
              ],
            ),
    bottomNavigationBar: const HomeBottomNav(),
    );
  }

  Widget _planCard(Map<String, dynamic> t, {required String currentTier}) {
    final isCurrent = t['kind'] == currentTier;
    final recommended = t['recommended'] == true;
    final color = t['color'] as Color;

    return Container(
      margin: const EdgeInsets.only(bottom: 14),
      decoration: BoxDecoration(
        color: AppColors.surface,
        border: Border.all(
            color: isCurrent ? color : (recommended ? color : AppColors.divider),
            width: isCurrent || recommended ? 2 : 1),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (recommended)
            Container(
              padding: const EdgeInsets.symmetric(vertical: 4),
              color: color,
              child: const Center(
                child: Text('RECOMMENDED',
                    style: TextStyle(
                        color: Colors.white,
                        fontWeight: FontWeight.w900,
                        letterSpacing: 1.4,
                        fontSize: 10)),
              ),
            ),
          Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Text(t['label'] as String,
                        style: TextStyle(
                            color: color,
                            fontSize: 22,
                            fontWeight: FontWeight.w900)),
                    const Spacer(),
                    Text(t['price'] as String,
                        style: const TextStyle(
                            fontWeight: FontWeight.w900, fontSize: 22)),
                  ],
                ),
                Row(
                  children: [
                    Text(t['tagline'] as String,
                        style: const TextStyle(color: AppColors.textSecondary)),
                    const Spacer(),
                    Text(t['period'] as String,
                        style: const TextStyle(
                            color: AppColors.textSecondary, fontSize: 11)),
                  ],
                ),
                const SizedBox(height: 12),
                ...((t['features'] as List).cast<String>().map((f) => Padding(
                      padding: const EdgeInsets.symmetric(vertical: 2),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Icon(Icons.check_rounded, color: color, size: 16),
                          const SizedBox(width: 8),
                          Expanded(
                              child: Text(f,
                                  style: const TextStyle(fontSize: 13))),
                        ],
                      ),
                    ))),
                const SizedBox(height: 12),
                SizedBox(
                  width: double.infinity, height: 44,
                  child: ElevatedButton(
                    onPressed: (isCurrent || _checkoutBusy)
                        ? null
                        : () => _upgrade(t['kind'] as String),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: color,
                      foregroundColor: Colors.white,
                      disabledBackgroundColor: AppColors.divider,
                    ),
                    child: (_checkoutBusy && _pendingTier == t['kind'])
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(
                                strokeWidth: 2.4, color: Colors.white))
                        : Text(
                            isCurrent ? 'Your current plan'
                                : (currentTier == 'starter' && t['kind'] == 'pro' ? 'Upgrade to Pro'
                                : t['kind'] == 'enterprise' ? 'Upgrade to Enterprise'
                                : 'Switch plan'),
                            style: const TextStyle(fontWeight: FontWeight.w900),
                          ),
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
