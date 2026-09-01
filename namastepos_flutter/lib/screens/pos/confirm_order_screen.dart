// NamastePOS - Confirm order, choose source/table/payment, save & print

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'package:uuid/uuid.dart';

import '../../constants/colors.dart';
import '../../models/customer.dart';
import '../../models/order.dart';
import '../../providers/auth_provider.dart';
import '../../providers/orders_provider.dart';
import '../../providers/settings_provider.dart';
import '../../providers/subscription_provider.dart';
import '../../services/api_service.dart';
import '../../services/printer_service.dart';
// PaperSize is now re-exported from our local stub, no longer from esc_pos_utils.
import '../../services/whatsapp_service.dart';
import '../../utils/error_humanizer.dart';
import '../../utils/formatters.dart';
import '../../widgets/membership_offer_dialog.dart';
import '../../widgets/primary_button.dart';
import '../captain/captain_screen.dart' show pendingCaptainSession;

class ConfirmOrderScreen extends StatefulWidget {
  const ConfirmOrderScreen({super.key});

  @override
  State<ConfirmOrderScreen> createState() => _ConfirmOrderScreenState();
}

class _ConfirmOrderScreenState extends State<ConfirmOrderScreen> {
  OrderSource _source = OrderSource.dineIn;
  PaymentMethod _payment = PaymentMethod.cash;
  final _table = TextEditingController(text: '1');
  final _phone = TextEditingController();
  final _discount = TextEditingController(text: '0');
  // Coupon-at-checkout (2026-08-26): cashier types a promo code; the server
  // validates + prices it (percent/flat, rupee cap, expiry, redemption cap)
  // and returns the discount, which stacks on top of the manual discount.
  final _coupon = TextEditingController();
  double _couponDiscount = 0;
  String? _appliedCoupon;
  bool _applyingCoupon = false;
  bool _saving = false;
  // Idempotency (2026-08-30 review): a stable clientId minted once per checkout
  // and REUSED across retries, so a split order the server committed but that
  // timed out client-side isn't duplicated (double wallet/loyalty debit) when
  // the cashier taps Confirm again. Cleared on success so the next order is new.
  String? _pendingClientId;
  // FF-322 mobile split-tender. When non-null the order is submitted
  // as a multi-leg payment. Each entry is {method, amountInr}. Sum
  // must equal the total; validated in the bottom-sheet before we
  // let the cashier out.
  List<Map<String, dynamic>>? _splits;

  // Loyalty state (only used if loyalty addon active)
  Customer? _customer;
  LoyaltySettingsLite? _loyaltySettings;
  int _pointsToRedeem = 0;
  bool _looking = false;

  // Wallet-as-tender (2026-08-25, round-2 parity): balance fetched once a
  // real customer matches — mirrors dashboard NewOrderDialog. Any fetch
  // error (402 = loyalty addon missing) simply hides the wallet option in
  // the split sheet instead of surfacing an error to the cashier.
  double _walletBalance = 0;
  bool _walletAvailable = false;
  // Wallet-as-tender auto-apply (2026-08-30): pre-checked when the customer has
  // a balance; cashier can uncheck or cap the amount. Server sizes the actual
  // use against the post-membership due.
  bool _useWallet = true;
  final _walletCap = TextEditingController();
  double? _walletCapInr() {
    final t = _walletCap.text.trim();
    if (t.isEmpty) return null; // null = use full balance (server caps at due)
    final v = double.tryParse(t);
    return (v != null && v > 0) ? v : null;
  }

  // Membership context (2026-08-23): active bundle → server auto-applies
  // covered items as a discount at billing. Expired/absent → offer shown
  // at Pay & Place time (founder: the popup belongs where money changes
  // hands, not at phone entry).
  Map<String, dynamic>? _membership;
  Map<String, dynamic>? _expiredMembership;
  bool _membershipOfferShown = false; // once per order
  double _membershipFeeInr = 0; // bought/renewed during THIS billing

  // Captain-flow binding — when captain → Add items is used, this carries
  // the session id + table label so we can pre-fill and tag the new KOT.
  String? _tableSessionId;
  String? _boundTableId;

  // Surge pricing (2026-08-23): active rule fetched on open. multiplier
  // > 1 scales every line price; banner shows the cashier why.
  double _surgeMultiplier = 1.0;
  String? _surgeName;

  @override
  void initState() {
    super.initState();
    final pending = pendingCaptainSession;
    if (pending != null) {
      _tableSessionId = pending['sessionId'] as String?;
      _boundTableId = pending['tableId'] as String?;
      _table.text = (pending['tableLabel'] as String?) ?? _table.text;
      _source = OrderSource.dineIn;
    }
    _loadSurge();
  }

  Future<void> _loadSurge() async {
    try {
      final biz = context.read<AuthProvider>().business;
      if (biz == null) return;
      final r = await ApiService.instance.dio
          .get('/businesses/${biz.id}/surge/current');
      final s = (r.data['surge'] as Map?)?.cast<String, dynamic>();
      if (s == null || !mounted) return;
      final mult = double.tryParse(s['multiplier'].toString()) ?? 1.0;
      if (mult > 1.0) {
        setState(() {
          _surgeMultiplier = mult;
          _surgeName = s['name'] as String?;
        });
      }
    } catch (_) { /* no surge — normal pricing */ }
  }

  @override
  void dispose() {
    _table.dispose();
    _phone.dispose();
    _discount.dispose();
    _coupon.dispose();
    _walletCap.dispose();
    // Don't clear pendingCaptainSession here — captain_screen clears it
    // when its post-push .then() callback fires, so we don't double-clear
    // and break a sibling confirm screen mid-flow.
    super.dispose();
  }

  Future<void> _lookupCustomer() async {
    final phone = _phone.text.trim();
    if (phone.length < 10) return;
    final hasLoyalty = context.read<SubscriptionProvider>().hasAddon('loyalty');
    if (!hasLoyalty) return;

    setState(() => _looking = true);
    final biz = context.read<AuthProvider>().business!;
    try {
      final data = await ApiService.instance.lookupCustomer(biz.id, phone);
      if (!mounted) return; // P2 fix: user may back out mid-lookup
      if (data == null) {
        setState(() {
          _customer = null;
          _loyaltySettings = null;
          _walletBalance = 0;
          _walletAvailable = false;
          _looking = false;
        });
        return;
      }
      final cu = data['customer'];
      final st = data['loyaltySettings'];
      final mem = (data['membership'] as Map?)?.cast<String, dynamic>();
      final expired =
          (data['expiredMembership'] as Map?)?.cast<String, dynamic>();
      // Wallet balance ride-along (2026-08-25): fetched here (not lazily in
      // the split sheet) so the sheet can render the balance synchronously.
      // Best-effort — a failure just hides the wallet tender.
      double walletBal = 0;
      bool walletOk = false;
      if (cu != null) {
        try {
          final w = await ApiService.instance
              .walletFor(biz.id, (cu as Map)['id'].toString());
          if (w != null) {
            walletBal = (w['balanceInr'] as num?)?.toDouble() ?? 0;
            walletOk = true;
          }
        } catch (_) { /* wallet hidden */ }
      }
      if (!mounted) return;
      setState(() {
        _customer = cu != null ? Customer.fromMap((cu as Map).cast<String, dynamic>()) : null;
        _loyaltySettings = st != null
            ? LoyaltySettingsLite.fromMap(st as Map<String, dynamic>)
            : null;
        _membership = mem;
        _expiredMembership = expired; // offer fires at Pay & Place
        _pointsToRedeem = 0;
        _walletBalance = walletBal;
        _walletAvailable = walletOk;
        _useWallet = walletOk && walletBal > 0; // pre-check when there's a balance
        _looking = false;
      });
    } catch (_) {
      if (mounted) setState(() => _looking = false);
    }
  }

  /// Membership offer at Pay & Place (2026-08-23, founder): when the
  /// customer has no active membership (never had one, or it expired),
  /// show the buy/renew popup RIGHT when the cashier taps Pay & Place.
  /// A purchase adds the plan fee to this billing (shown in the collect
  /// total) and the bundle discounts THIS order. "Not now" → normal
  /// billing. KOT-only saves skip this — the settle flow offers instead.
  Future<void> _maybeOfferMembership() async {
    if (_membershipOfferShown) return;
    if (_customer == null || _membership != null) return;
    _membershipOfferShown = true;
    final fee = await showMembershipOfferDialog(
      context,
      customerId: _customer!.id,
      customerLabel: _customer!.name ?? _customer!.phone,
      expired: _expiredMembership,
    );
    if (fee != null && mounted) {
      setState(() => _membershipFeeInr = fee);
      await _lookupCustomer(); // bundle is active now — refresh banner
    }
  }

  /// `kotOnly = true` → send to kitchen without taking payment (postpaid).
  /// Common for dine-in: send food prep, settle later when guests are done.
  Future<void> _submit({bool kotOnly = false}) async {
    // Review 2026-08-28: re-entrancy guard MUST be the first synchronous
    // statement. Previously `_saving` was set only after `_maybeOfferMembership`
    // (an await), so a double-tap re-entered and placed the order twice
    // (double wallet debit + double loyalty burn). Guard first, then await.
    if (_saving) return;
    setState(() => _saving = true);
    // Membership upsell fires exactly when payment happens (not on KOT
    // saves — those get the offer at settle).
    if (!kotOnly) {
      await _maybeOfferMembership();
      if (!mounted) return;
    }
    // P0 fix (2026-08-22): the whole flow (createOrderFromCart +
    // print + WhatsApp) had no try/finally — any thrown error left
    // `_saving = true` forever, so the Confirm button was permanently
    // greyed until the app was restarted. This wraps everything in a
    // try/catch/finally: the button always re-enables, and the owner
    // sees a humanised error snackbar instead of frozen UI.
    setState(() => _saving = true);
    final orders = context.read<OrdersProvider>();
    final auth = context.read<AuthProvider>();
    final settings = context.read<SettingsProvider>();
    final messenger = ScaffoldMessenger.of(context);

    Order? order;
    bool printed = false;
    String? _printError; // P1 fix: surface printer failures to the owner
    try {
      // Coupon discount stacks onto the manual discount — the backend order
      // stores a single discount amount, so send the combined figure.
      final discount = (double.tryParse(_discount.text.trim()) ?? 0) + _couponDiscount;
      final biz = auth.business!;
      _pendingClientId ??= const Uuid().v4(); // stable across retries
      order = await orders.createOrderFromCart(
        businessId: biz.id,
        source: _source,
        clientId: _pendingClientId,
        tableNo: _source == OrderSource.dineIn ? _table.text.trim() : null,
        customerPhone: _phone.text.trim().isEmpty ? null : _phone.text.trim(),
        paymentMethod: kotOnly ? PaymentMethod.unpaid : _payment,
        discount: discount,
        // Send the applied coupon code so the server records its use + enforces
        // max_redemptions (2026-09-01). The discount amount is already in
        // `discount`; this is only for cap tracking.
        couponCode: kotOnly ? null : _appliedCoupon,
        pointsToRedeem: _pointsToRedeem,
        priceMultiplier: _surgeMultiplier, // surge (×1 when inactive)
        // Captain "Add items" flow — bind the new KOT to the exact open
        // session instead of relying on the table-label lookup.
        tableSessionId: _tableSessionId,
        tableId: _boundTableId,
        // Round-2 (2026-08-25): split legs now ride the strict
        // `paymentBreakdown` contract (wallet support + server-enforced
        // sum = total ±₹0.01) instead of the legacy `splits` key.
        // Ignored on KOT-only saves — an unpaid order has no tender.
        paymentBreakdown: (!kotOnly && _splits != null && _splits!.isNotEmpty)
            ? _splits : null,
        // Wallet-as-tender auto-apply (2026-08-30): only on a real payment,
        // when the cashier left "Use wallet" on and isn't running a manual
        // split. Server draws the wallet down for the residual after the
        // membership bundle; walletCapInr caps it (default = full balance).
        autoWallet: !kotOnly && _useWallet && _walletAvailable
            && (_splits == null || _splits!.isEmpty),
        walletCapInr: _walletCapInr(),
      );
      _pendingClientId = null; // placed successfully — next order gets a new id

      // Print (best-effort — never fails the order).
      // P1 fix (2026-08-22): errors were swallowed with just a debugPrint,
      // owners had no idea why the KOT never came out. We now capture the
      // failure into `_printError` so the confirmation dialog can show it,
      // AND we snackbar right away if the widget is still mounted.
      if (settings.printerEnabled && PrinterService.instance.hasSelectedPrinter) {
        PrinterService.instance.paperSize =
            settings.paperWidthMm == 80 ? PaperSize.mm80 : PaperSize.mm58;
        try {
          printed = await PrinterService.instance.printToken(order, biz);
          if (printed) await orders.markPrinted(order.id);
          else _printError = 'Printer returned no acknowledgement';
        } catch (e) {
          _printError = humanizeError(e);
          debugPrint('[POS] print failed: $e');
          if (mounted) {
            messenger.showSnackBar(SnackBar(
              content: Text('Printer error: $_printError'),
              backgroundColor: AppColors.warning,
            ));
          }
        }
      }

      // WhatsApp auto-notify — best-effort, plan-gated.
      // Fix (2026-08-22, founder): NEVER for dine-in — the waiter serves
      // at the table; yanking the cashier into WhatsApp mid-service broke
      // the POS flow. Takeaway/delivery keep the confirmation message.
      final hasAutoWhatsApp = auth.has('auto_whatsapp_order');
      if (_source != OrderSource.dineIn &&
          order.customerPhone != null && order.customerPhone!.isNotEmpty &&
          settings.autoWhatsAppOnReady && hasAutoWhatsApp) {
        try {
          await WhatsAppService.instance.notifyOrderConfirmed(order, biz);
        } catch (e) {
          debugPrint('[POS] whatsapp notify failed: $e');
        }
      }
    } catch (e) {
      // Order-create failure — surface a humanised error and let the
      // owner retry. Do NOT show the "Order placed" dialog.
      if (mounted) {
        messenger.showSnackBar(SnackBar(
          content: Text('Could not place order: ${humanizeError(e)}'),
          backgroundColor: AppColors.error,
        ));
        setState(() => _saving = false);
      }
      return;
    }

    if (!mounted) return;
    setState(() => _saving = false);
    // Wallet-as-tender (2026-08-31 review fix): the server records the wallet
    // draw-down as a paymentBreakdown leg, NOT a deduction from order.total.
    // So the CASH the cashier must collect = order.total − wallet + membership.
    // Previously the dialog showed the gross total (and even told the cashier to
    // COLLECT total + membership), making them over-collect by the wallet amount.
    final o = order; // promoted non-null here; captured for the dialog closure
    final walletPaid = (o.paymentBreakdown ?? const <Map<String, dynamic>>[])
        .where((l) => (l['method'] as String?) == 'wallet')
        .fold<double>(0, (s, l) => s + ((l['amountInr'] as num?)?.toDouble() ?? 0));
    final netCollect = (o.total - walletPaid + _membershipFeeInr)
        .clamp(0, double.infinity)
        .toDouble();
    final showCollect = walletPaid > 0 || _membershipFeeInr > 0;
    showDialog(
      context: context,
      builder: (_) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        title: const Text('Order placed'),
        content: Text(
          'Token #${o.orderNo} • ${AppFmt.money(o.total, decimals: true)}\n'
          '${walletPaid > 0
              ? "− Paid from wallet ${AppFmt.money(walletPaid, decimals: true)}\n"
              : ""}'
          // Membership bought during this billing (order total already reflects
          // any bundle discount).
          '${_membershipFeeInr > 0
              ? "+ Membership ${AppFmt.money(_membershipFeeInr)}\n"
              : ""}'
          '${showCollect
              ? "COLLECT ${AppFmt.money(netCollect, decimals: true)} in cash\n"
              : ""}'
          '${printed
              ? "Token printed successfully."
              : (settings.printerEnabled
                  ? (_printError != null
                      ? "Printer error: $_printError"
                      : "Printer not connected — saved without printing.")
                  : "")}',
        ),
        actions: [
          TextButton(
            onPressed: () {
              // popUntil first → unwinds the dialog + confirm screen +
              // (if pushed from Captain) the NewOrderScreen, landing the
              // user back on the bottom-nav shell with their previous
              // tab still active. Previously only popped twice which
              // left them stuck on NewOrderScreen with no clear way out.
              Navigator.popUntil(context, (r) => r.isFirst);
            },
            child: const Text('Done'),
          ),
          if (!printed && settings.printerEnabled)
            TextButton(
              onPressed: () async {
                final biz2 = auth.business!;
                try {
                  final ok = await PrinterService.instance.printToken(order!, biz2);
                  if (ok) {
                    await orders.markPrinted(order.id);
                  } else if (mounted) {
                    messenger.showSnackBar(const SnackBar(
                      content: Text('Printer did not acknowledge — check paper & power'),
                      backgroundColor: AppColors.warning,
                    ));
                  }
                } catch (e) {
                  if (mounted) {
                    messenger.showSnackBar(SnackBar(
                      content: Text('Printer error: ${humanizeError(e)}'),
                      backgroundColor: AppColors.error,
                    ));
                  }
                }
                if (!mounted) return;
                Navigator.popUntil(context, (r) => r.isFirst);
              },
              child: const Text('Retry print'),
            ),
        ],
      ),
    );
  }

  Future<void> _applyCoupon() async {
    final code = _coupon.text.trim();
    if (code.isEmpty) return;
    final orders = context.read<OrdersProvider>();
    final subtotal = orders.cartSubtotal * _surgeMultiplier;
    final messenger = ScaffoldMessenger.of(context);
    if (subtotal <= 0) {
      messenger.showSnackBar(const SnackBar(content: Text('Add items first')));
      return;
    }
    setState(() => _applyingCoupon = true);
    try {
      final biz = context.read<AuthProvider>().business!;
      final r = await ApiService.instance.applyFoodCoupon(
        businessId: biz.id,
        code: code,
        subtotal: subtotal,
        customerId: _customer?.id,
      );
      final disc = (r['discountInr'] as num?)?.toDouble() ?? 0;
      if (!mounted) return;
      setState(() {
        _couponDiscount = disc;
        _appliedCoupon = code.toUpperCase();
        _splits = null; // total changed → any saved split is now stale
      });
      messenger.showSnackBar(SnackBar(
        content: Text('Coupon $_appliedCoupon applied — ${AppFmt.money(disc, decimals: true)} off')));
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() { _couponDiscount = 0; _appliedCoupon = null; });
      messenger.showSnackBar(SnackBar(content: Text(e.message)));
    } catch (e) {
      if (!mounted) return;
      setState(() { _couponDiscount = 0; _appliedCoupon = null; });
      messenger.showSnackBar(SnackBar(content: Text('$e')));
    } finally {
      if (mounted) setState(() => _applyingCoupon = false);
    }
  }

  void _removeCoupon() => setState(() {
        _appliedCoupon = null;
        _couponDiscount = 0;
        _coupon.clear();
        _splits = null;
      });

  @override
  Widget build(BuildContext context) {
    final orders = context.watch<OrdersProvider>();
    final subtotal = orders.cartSubtotal * _surgeMultiplier;
    final discount = double.tryParse(_discount.text.trim()) ?? 0;
    final loyaltyDiscount = _loyaltySettings != null
        ? (_pointsToRedeem * _loyaltySettings!.redemptionValuePaise) / 100
        : 0.0;
    final total = (subtotal - discount - loyaltyDiscount - _couponDiscount)
        .clamp(0, double.infinity);

    return Scaffold(
      // Bug fix (2026-08-20): make the back-arrow explicit + always pop
      // to home instead of relying on the auto-added leading. If a
      // "place order" flow got interrupted (customer cancelled at
      // counter, network hiccup, dialog dismissed early) the user
      // would previously find themselves on this screen with an
      // arrow that seemed to do nothing. Now it always exits POS.
      appBar: AppBar(
        title: const Text('Confirm order'),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          tooltip: 'Back',
          onPressed: () {
            final nav = Navigator.of(context);
            if (nav.canPop()) nav.pop();
            else nav.popUntil((r) => r.isFirst);
          },
        ),
      ),
      body: SafeArea(
        child: Column(
          children: [
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
                children: [
                  // Cart items
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: AppColors.surface,
                      borderRadius: BorderRadius.circular(14),
                      border: Border.all(color: AppColors.divider),
                    ),
                    child: Column(
                      children: orders.cart.map((ci) => Padding(
                        padding: const EdgeInsets.symmetric(vertical: 6),
                        child: Row(
                          children: [
                            Expanded(
                              child: Text('${ci.item.name} x ${ci.qty}',
                                  style: const TextStyle(fontWeight: FontWeight.w600)),
                            ),
                            Text(AppFmt.money(ci.lineTotal, decimals: true)),
                          ],
                        ),
                      )).toList(),
                    ),
                  ),
                  const SizedBox(height: 16),

                  // Source
                  const Text('Order source', style: _labelStyle),
                  const SizedBox(height: 8),
                  SizedBox(
                    height: 38,
                    child: ListView(
                      scrollDirection: Axis.horizontal,
                      children: OrderSource.values.map((s) {
                        final selected = s == _source;
                        return Padding(
                          padding: const EdgeInsets.only(right: 8),
                          child: ChoiceChip(
                            label: Text(_sourceLabel(s)),
                            selected: selected,
                            onSelected: (_) => setState(() => _source = s),
                            selectedColor: AppColors.primary,
                            labelStyle: TextStyle(
                              color: selected ? Colors.white : AppColors.textPrimary,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        );
                      }).toList(),
                    ),
                  ),
                  const SizedBox(height: 16),

                  // Table
                  if (_source == OrderSource.dineIn) ...[
                    const Text('Table number', style: _labelStyle),
                    const SizedBox(height: 8),
                    TextField(
                      controller: _table,
                      keyboardType: TextInputType.number,
                      inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                      decoration: const InputDecoration(hintText: 'e.g. 3'),
                    ),
                    const SizedBox(height: 16),
                  ],

                  // Customer phone
                  const Text('Customer phone (optional — for WhatsApp & loyalty)', style: _labelStyle),
                  const SizedBox(height: 8),
                  TextField(
                    controller: _phone,
                    keyboardType: TextInputType.phone,
                    inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(10)],
                    decoration: InputDecoration(
                      hintText: '9876543210',
                      suffixIcon: _looking
                          ? const SizedBox(width: 18, height: 18,
                              child: Padding(padding: EdgeInsets.all(12),
                                child: CircularProgressIndicator(strokeWidth: 2)))
                          : null,
                    ),
                    onChanged: (v) {
                      if (v.length == 10) _lookupCustomer();
                      else if (_customer != null) {
                        // Customer cleared → wallet tender is gone too, and
                        // any saved split may hold a now-invalid wallet leg
                        // (server would 400) — drop it (2026-08-25).
                        setState(() {
                          _customer = null;
                          _pointsToRedeem = 0;
                          _walletBalance = 0;
                          _walletAvailable = false;
                          _splits = null;
                        });
                      }
                    },
                  ),
                  if (_customer != null && _membership != null)
                    Container(
                      width: double.infinity,
                      margin: const EdgeInsets.only(top: 8),
                      padding: const EdgeInsets.symmetric(
                          horizontal: 10, vertical: 6),
                      decoration: BoxDecoration(
                        color: AppColors.success.withValues(alpha: 0.12),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Text(
                        _membership!['remaining'] is List &&
                                (_membership!['remaining'] as List).isNotEmpty
                            ? '✓ ${_membership!['name'] ?? 'Membership'} member — '
                                'bundle items are auto-discounted on the bill.'
                            : '✓ ${_membership!['name'] ?? 'Membership'} member '
                                '(no item bundle left on this plan).',
                        style: const TextStyle(
                            color: AppColors.success,
                            fontWeight: FontWeight.w700,
                            fontSize: 12),
                      ),
                    ),
                  if (_customer != null && _loyaltySettings != null && _loyaltySettings!.isActive)
                    _LoyaltyCard(
                      customer: _customer!,
                      settings: _loyaltySettings!,
                      billInr: context.read<OrdersProvider>().cartSubtotal,
                      pointsToRedeem: _pointsToRedeem,
                      // Changing redemption also invalidates a saved split
                      onChange: (v) => setState(() { _pointsToRedeem = v; _splits = null; }),
                    ),
                  const SizedBox(height: 16),

                  // Wallet-as-tender (2026-08-30): pre-checked when the matched
                  // customer has a balance. Server uses it for the residual due
                  // AFTER the membership bundle; the rest goes to the method
                  // chosen below. Cashier can switch it off or cap the amount.
                  if (_walletAvailable && _walletBalance > 0) ...[
                    Container(
                      decoration: BoxDecoration(
                        color: AppColors.primary.withValues(alpha: 0.06),
                        borderRadius: BorderRadius.circular(10),
                      ),
                      child: Column(children: [
                        SwitchListTile(
                          value: _useWallet,
                          onChanged: _splits != null
                              ? null // wallet auto-apply is off while a manual split is set
                              : (v) => setState(() => _useWallet = v),
                          title: const Text('Use wallet balance',
                              style: TextStyle(fontWeight: FontWeight.w600)),
                          subtitle: Text(
                            'Balance ₹${_walletBalance.toStringAsFixed(2)} • applied after membership; '
                            'remaining via ${_payment.name.toUpperCase()}',
                            style: const TextStyle(fontSize: 12, color: AppColors.textSecondary),
                          ),
                          dense: true,
                        ),
                        if (_useWallet)
                          Padding(
                            padding: const EdgeInsets.fromLTRB(16, 0, 16, 10),
                            child: TextField(
                              controller: _walletCap,
                              keyboardType: const TextInputType.numberWithOptions(decimal: true),
                              inputFormatters: [
                                FilteringTextInputFormatter.allow(RegExp(r'[0-9.]')),
                              ],
                              decoration: InputDecoration(
                                isDense: true,
                                labelText: 'Max wallet to use (optional)',
                                hintText: 'Blank = up to ₹${_walletBalance.toStringAsFixed(0)}',
                                border: const OutlineInputBorder(),
                              ),
                            ),
                          ),
                      ]),
                    ),
                    const SizedBox(height: 16),
                  ],

                  // Payment
                  const Text('Payment method', style: _labelStyle),
                  const SizedBox(height: 8),
                  Wrap(
                    spacing: 8,
                    children: PaymentMethod.values.where((p) => p != PaymentMethod.unpaid).map((p) {
                      final selected = p == _payment;
                      return ChoiceChip(
                        label: Text(p.name.toUpperCase()),
                        selected: selected,
                        onSelected: (_) => setState(() {
                          _payment = p;
                          _splits = null; // single-tender clears any prior split
                        }),
                        selectedColor: AppColors.primary,
                        labelStyle: TextStyle(
                          color: selected ? Colors.white : AppColors.textPrimary,
                          fontWeight: FontWeight.w600,
                        ),
                      );
                    }).toList(),
                  ),
                  const SizedBox(height: 8),
                  // FF-322 mobile split-tender entry point. Compact
                  // button + status chip so the cashier knows a split
                  // is active. Sum-vs-total is validated inside the
                  // bottom-sheet before Save.
                  Row(
                    children: [
                      OutlinedButton.icon(
                        icon: const Icon(Icons.call_split, size: 16),
                        label: Text(_splits == null
                            ? 'Split payment'
                            : 'Split (${_splits!.length} legs)'),
                        onPressed: () async {
                          // P1 fix (2026-08-22): validate against the REAL
                          // payable total (incl. loyalty redemption), not
                          // subtotal-minus-discount — legs were forced to
                          // overshoot when points were redeemed.
                          final subtotalNow =
                              context.read<OrdersProvider>().cartSubtotal *
                                  _surgeMultiplier;
                          final discountNow = double.tryParse(_discount.text.trim()) ?? 0;
                          final loyaltyNow = _loyaltySettings != null
                              ? (_pointsToRedeem * _loyaltySettings!.redemptionValuePaise) / 100
                              : 0.0;
                          final result = await showModalBottomSheet<List<Map<String, dynamic>>?>(
                            context: context,
                            isScrollControlled: true,
                            builder: (_) => _SplitTenderSheet(
                              total: (subtotalNow - discountNow - loyaltyNow - _couponDiscount)
                                  .clamp(0, double.infinity)
                                  .toDouble(),
                              // Wallet-as-tender (2026-08-25): option only
                              // renders for a matched customer, with the
                              // live balance on the label.
                              walletAvailable: _walletAvailable,
                              walletBalance: _walletBalance,
                            ),
                          );
                          if (result != null) setState(() => _splits = result);
                        },
                      ),
                      if (_splits != null) ...[
                        const SizedBox(width: 8),
                        TextButton(
                          onPressed: () => setState(() => _splits = null),
                          child: const Text('Clear split'),
                        ),
                      ],
                    ],
                  ),
                  const SizedBox(height: 16),

                  // Discount
                  const Text('Discount (₹)', style: _labelStyle),
                  const SizedBox(height: 8),
                  TextField(
                    controller: _discount,
                    keyboardType: TextInputType.number,
                    // P1 fix (2026-08-22): changing the discount after a
                    // split was saved left legs that no longer summed to
                    // the total — clear the stale split.
                    onChanged: (_) => setState(() => _splits = null),
                    decoration: const InputDecoration(hintText: '0'),
                  ),
                  const SizedBox(height: 16),

                  // Coupon code
                  const Text('Coupon code', style: _labelStyle),
                  const SizedBox(height: 8),
                  if (_appliedCoupon == null)
                    Row(
                      children: [
                        Expanded(
                          child: TextField(
                            controller: _coupon,
                            textCapitalization: TextCapitalization.characters,
                            enabled: !_applyingCoupon,
                            onSubmitted: (_) => _applyCoupon(),
                            decoration: const InputDecoration(hintText: 'e.g. SAVE10'),
                          ),
                        ),
                        const SizedBox(width: 8),
                        SizedBox(
                          height: 48,
                          child: OutlinedButton(
                            onPressed: _applyingCoupon ? null : _applyCoupon,
                            child: _applyingCoupon
                                ? const SizedBox(
                                    width: 18, height: 18,
                                    child: CircularProgressIndicator(strokeWidth: 2))
                                : const Text('Apply'),
                          ),
                        ),
                      ],
                    )
                  else
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                      decoration: BoxDecoration(
                        color: AppColors.success.withValues(alpha: 0.12),
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: AppColors.success.withValues(alpha: 0.4)),
                      ),
                      child: Row(
                        children: [
                          const Icon(Icons.local_offer_outlined,
                              size: 18, color: AppColors.success),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              '$_appliedCoupon · ${AppFmt.money(_couponDiscount, decimals: true)} off',
                              style: const TextStyle(
                                  color: AppColors.success, fontWeight: FontWeight.w700),
                            ),
                          ),
                          TextButton(
                            onPressed: _removeCoupon,
                            child: const Text('Remove'),
                          ),
                        ],
                      ),
                    ),
                ],
              ),
            ),

            // Totals + CTA
            Container(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
              decoration: BoxDecoration(
                color: AppColors.surface,
                border: Border(top: BorderSide(color: AppColors.divider)),
              ),
              child: Column(
                children: [
                  if (_surgeMultiplier > 1.0)
                    Container(
                      width: double.infinity,
                      margin: const EdgeInsets.only(bottom: 8),
                      padding: const EdgeInsets.symmetric(
                          horizontal: 10, vertical: 6),
                      decoration: BoxDecoration(
                        color: AppColors.warning.withValues(alpha: 0.14),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Text(
                        '⚡ Surge pricing ×${_surgeMultiplier.toStringAsFixed(2)}'
                        '${_surgeName != null ? " ($_surgeName)" : ""} — '
                        'prices adjusted',
                        style: const TextStyle(
                            color: AppColors.warning,
                            fontWeight: FontWeight.w700,
                            fontSize: 12),
                      ),
                    ),
                  Row(
                    children: [
                      const Text('Subtotal', style: TextStyle(color: AppColors.textSecondary)),
                      const Spacer(),
                      Text(AppFmt.money(subtotal, decimals: true)),
                    ],
                  ),
                  const SizedBox(height: 4),
                  Row(
                    children: [
                      const Text('Discount', style: TextStyle(color: AppColors.textSecondary)),
                      const Spacer(),
                      Text('-${AppFmt.money(discount, decimals: true)}'),
                    ],
                  ),
                  if (_couponDiscount > 0) ...[
                    const SizedBox(height: 4),
                    Row(
                      children: [
                        Text('Coupon ($_appliedCoupon)',
                            style: const TextStyle(color: AppColors.success)),
                        const Spacer(),
                        Text('-${AppFmt.money(_couponDiscount, decimals: true)}',
                            style: const TextStyle(color: AppColors.success)),
                      ],
                    ),
                  ],
                  if (loyaltyDiscount > 0) ...[
                    const SizedBox(height: 4),
                    Row(
                      children: [
                        Text('Loyalty ($_pointsToRedeem pts)', style: const TextStyle(color: AppColors.primary)),
                        const Spacer(),
                        Text('-${AppFmt.money(loyaltyDiscount, decimals: true)}',
                            style: const TextStyle(color: AppColors.primary)),
                      ],
                    ),
                  ],
                  const Divider(height: 18),
                  Row(
                    children: [
                      const Text('Total',
                          style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
                      const Spacer(),
                      Text(
                        AppFmt.money(total, decimals: true),
                        style: const TextStyle(
                          fontWeight: FontWeight.w800,
                          fontSize: 20,
                          color: AppColors.primary,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  // Dine-in flow: "Save KOT" sends food prep to the kitchen
                  // WITHOUT settling payment yet — settle later from the
                  // table running-bill view. Takeaway/delivery default to
                  // "Pay & place" which collects payment immediately.
                  if (_source == OrderSource.dineIn) ...[
                    OutlinedButton.icon(
                      icon: const Icon(Icons.restaurant_menu_rounded),
                      label: _saving
                          ? const Text('Saving…')
                          : const Text('Save KOT (settle later)',
                              style: TextStyle(fontWeight: FontWeight.w800)),
                      style: OutlinedButton.styleFrom(
                        minimumSize: const Size.fromHeight(48),
                        side: const BorderSide(color: AppColors.primary, width: 1.5),
                        foregroundColor: AppColors.primary,
                      ),
                      onPressed: _saving ? null : () => _submit(kotOnly: true),
                    ),
                    const SizedBox(height: 8),
                  ],
                  PrimaryButton(
                    label: _source == OrderSource.dineIn
                        ? 'Pay & Place'
                        : 'Place Order & Print Token',
                    loading: _saving,
                    onPressed: () => _submit(),
                    icon: Icons.print_rounded,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  String _sourceLabel(OrderSource s) {
    switch (s) {
      case OrderSource.dineIn: return 'Dine-in';
      case OrderSource.takeaway: return 'Takeaway';
      case OrderSource.zomato: return 'Zomato';
      case OrderSource.swiggy: return 'Swiggy';
      case OrderSource.other: return 'Other';
    }
  }
}

const TextStyle _labelStyle = TextStyle(
  fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.textPrimary,
);

class _LoyaltyCard extends StatelessWidget {
  final Customer customer;
  final LoyaltySettingsLite settings;
  final double billInr;
  final int pointsToRedeem;
  final ValueChanged<int> onChange;

  const _LoyaltyCard({
    required this.customer,
    required this.settings,
    required this.billInr,
    required this.pointsToRedeem,
    required this.onChange,
  });

  @override
  Widget build(BuildContext context) {
    final maxRedeem = settings.maxRedeemable(customer.pointsBalance, billInr);
    return Container(
      margin: const EdgeInsets.only(top: 10),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppColors.primary.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.primary.withValues(alpha: 0.3)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.card_giftcard_rounded, size: 18, color: AppColors.primary),
              const SizedBox(width: 8),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(customer.name?.isNotEmpty == true ? customer.name! : customer.phone,
                        style: const TextStyle(fontWeight: FontWeight.w700)),
                    Text(
                      '${customer.tier.toUpperCase()} · ${customer.pointsBalance} points · ${customer.visitCount} visits',
                      style: const TextStyle(fontSize: 11, color: AppColors.textSecondary),
                    ),
                  ],
                ),
              ),
            ],
          ),
          if (maxRedeem > 0) ...[
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: Slider(
                    value: pointsToRedeem.toDouble().clamp(0, maxRedeem.toDouble()),
                    min: 0, max: maxRedeem.toDouble(),
                    divisions: maxRedeem,
                    activeColor: AppColors.primary,
                    label: '$pointsToRedeem',
                    onChanged: (v) => onChange(v.round()),
                  ),
                ),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(
                    color: AppColors.primary, borderRadius: BorderRadius.circular(6),
                  ),
                  child: Text(
                    '-${AppFmt.moneyPaise(pointsToRedeem * settings.redemptionValuePaise)}',
                    style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: 12),
                  ),
                ),
              ],
            ),
            Text(
              'Max ${maxRedeem} pts (${AppFmt.moneyPaise(maxRedeem * settings.redemptionValuePaise)})',
              style: const TextStyle(fontSize: 11, color: AppColors.textSecondary),
            ),
          ] else
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                'Need ${settings.minRedemptionPoints} pts to redeem',
                style: const TextStyle(fontSize: 11, color: AppColors.textSecondary),
              ),
            ),
        ],
      ),
    );
  }
}

// ── FF-322 mobile split-tender bottom-sheet ─────────────────────────────
//
// Compact two-to-three leg entry. Total is fixed by the bill; each row
// is (method, amountInr). Balance is shown live. Round-2 rework
// (2026-08-25): legs are sent as the strict `paymentBreakdown` contract —
// max 3 legs, every leg positive, sum must match the total within ±₹0.01
// (the server 400s otherwise, so the old ±₹1 tolerance had to go), and a
// 'wallet' method appears when a customer is matched, showing the live
// balance and blocking over-spend client-side.

class _SplitTenderSheet extends StatefulWidget {
  final double total;
  final bool walletAvailable;
  final double walletBalance;
  const _SplitTenderSheet({
    required this.total,
    this.walletAvailable = false,
    this.walletBalance = 0,
  });
  @override
  State<_SplitTenderSheet> createState() => _SplitTenderSheetState();
}

class _SplitTenderSheetState extends State<_SplitTenderSheet> {
  final List<_SplitLeg> _legs = [];

  @override
  void initState() {
    super.initState();
    // Sensible defaults: two legs, cash + upi, half-and-half.
    final half = (widget.total / 2).toStringAsFixed(2);
    _legs.add(_SplitLeg(method: 'cash', ctl: TextEditingController(text: half)));
    _legs.add(_SplitLeg(method: 'upi',  ctl: TextEditingController(text: half)));
  }

  @override
  void dispose() {
    for (final l in _legs) l.ctl.dispose();
    super.dispose();
  }

  double get _sum => _legs.fold<double>(0, (s, l) =>
      s + (double.tryParse(l.ctl.text.trim()) ?? 0));
  double get _balance => widget.total - _sum;
  // Client-side mirror of the server's insufficient-wallet 400 — catch it
  // before the order round-trips and rolls back (2026-08-25).
  double get _walletSum => _legs
      .where((l) => l.method == 'wallet')
      .fold<double>(0, (s, l) => s + (double.tryParse(l.ctl.text.trim()) ?? 0));
  bool get _walletOver =>
      widget.walletAvailable && _walletSum > widget.walletBalance + 0.001;
  bool get _valid =>
      _balance.abs() <= 0.01 &&
      !_walletOver &&
      // ≥1 leg (a lone full-wallet tender is valid); backend requires each
      // paymentBreakdown leg to be POSITIVE.
      _legs.isNotEmpty &&
      _legs.every((l) => (double.tryParse(l.ctl.text.trim()) ?? 0) > 0);

  // One-tap: apply wallet balance (up to the bill), put any remainder on cash.
  // e.g. bill ₹300, wallet ₹290 → wallet ₹290 + cash ₹10.
  void _applyWallet() {
    final apply = widget.walletBalance >= widget.total ? widget.total : widget.walletBalance;
    final rem = widget.total - apply;
    setState(() {
      for (final l in _legs) l.ctl.dispose();
      _legs
        ..clear()
        ..add(_SplitLeg(method: 'wallet', ctl: TextEditingController(text: apply.toStringAsFixed(2))));
      if (rem > 0.001) {
        _legs.add(_SplitLeg(method: 'cash', ctl: TextEditingController(text: rem.toStringAsFixed(2))));
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final bottomInset = MediaQuery.of(context).viewInsets.bottom;
    return Padding(
      padding: EdgeInsets.only(bottom: bottomInset),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  const Icon(Icons.call_split, color: AppColors.primary),
                  const SizedBox(width: 8),
                  const Text('Split payment',
                      style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
                  const Spacer(),
                  Text('Total ${AppFmt.money(widget.total)}',
                      style: const TextStyle(
                          fontWeight: FontWeight.w700, color: AppColors.textSecondary)),
                ],
              ),
              if (widget.walletAvailable && widget.walletBalance > 0) ...[
                const SizedBox(height: 10),
                SizedBox(
                  width: double.infinity,
                  child: OutlinedButton.icon(
                    onPressed: _applyWallet,
                    icon: const Icon(Icons.account_balance_wallet_outlined, size: 18),
                    label: Text(
                      'Use wallet ${AppFmt.money(widget.walletBalance >= widget.total ? widget.total : widget.walletBalance)}'
                      '${widget.walletBalance < widget.total ? ' + ${AppFmt.money(widget.total - widget.walletBalance)} balance' : ''}',
                    ),
                  ),
                ),
              ],
              const SizedBox(height: 12),
              for (var i = 0; i < _legs.length; i++)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Row(
                    children: [
                      Expanded(
                        flex: 3,
                        child: DropdownButtonFormField<String>(
                          value: _legs[i].method,
                          decoration: const InputDecoration(labelText: 'Method'),
                          items: [
                            const DropdownMenuItem(value: 'cash',   child: Text('Cash')),
                            const DropdownMenuItem(value: 'upi',    child: Text('UPI')),
                            const DropdownMenuItem(value: 'card',   child: Text('Card')),
                            const DropdownMenuItem(value: 'online', child: Text('Online')),
                            // Wallet ONLY for a matched customer — the live
                            // balance rides on the label so the cashier can
                            // say it out loud (2026-08-25).
                            if (widget.walletAvailable)
                              DropdownMenuItem(
                                value: 'wallet',
                                child: Text(
                                    'Wallet — ${AppFmt.money(widget.walletBalance)}',
                                    overflow: TextOverflow.ellipsis),
                              ),
                          ],
                          onChanged: (v) =>
                              setState(() => _legs[i].method = v ?? 'cash'),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        flex: 4,
                        child: TextField(
                          controller: _legs[i].ctl,
                          keyboardType: const TextInputType.numberWithOptions(decimal: true),
                          decoration: const InputDecoration(labelText: 'Amount (₹)'),
                          onChanged: (_) => setState(() {}),
                        ),
                      ),
                      IconButton(
                        icon: const Icon(Icons.remove_circle_outline,
                            color: AppColors.error),
                        onPressed: _legs.length <= 2 ? null : () {
                          setState(() {
                            _legs[i].ctl.dispose();
                            _legs.removeAt(i);
                          });
                        },
                      ),
                    ],
                  ),
                ),
              // paymentBreakdown contract caps at 3 legs (2026-08-25) —
              // the earlier 4-leg cap would 400 on the strict endpoint.
              if (_legs.length < 3)
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton.icon(
                    onPressed: () => setState(() =>
                        _legs.add(_SplitLeg(method: 'cash', ctl: TextEditingController(text: '0')))),
                    icon: const Icon(Icons.add, size: 18),
                    label: const Text('Add leg'),
                  ),
                ),
              const Divider(),
              Row(
                children: [
                  const Text('Balance',
                      style: TextStyle(fontWeight: FontWeight.w700)),
                  const Spacer(),
                  Text(
                    // 2 decimals (2026-09-01) so a sub-rupee split imbalance is
                    // visible instead of showing a red "₹0".
                    AppFmt.money(_balance, decimals: true),
                    style: TextStyle(
                      fontWeight: FontWeight.w900,
                      color: _valid ? AppColors.success : AppColors.error,
                    ),
                  ),
                ],
              ),
              if (_walletOver)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text(
                    'Wallet has only ${AppFmt.money(widget.walletBalance)} — '
                    'reduce the wallet amount.',
                    style: const TextStyle(
                        color: AppColors.error, fontSize: 12,
                        fontWeight: FontWeight.w600),
                  ),
                ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      onPressed: () => Navigator.pop(context, null),
                      child: const Text('Cancel'),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: ElevatedButton(
                      onPressed: !_valid ? null : () {
                        // _valid already guarantees 2-3 positive legs that
                        // sum to the total ±₹0.01 — the shape the strict
                        // paymentBreakdown endpoint expects (2026-08-25).
                        final legs = _legs
                            .map((l) => {
                                  'method': l.method,
                                  'amountInr': double.parse(
                                      (double.tryParse(l.ctl.text.trim()) ?? 0)
                                          .toStringAsFixed(2)),
                                })
                            .toList();
                        Navigator.pop(context, legs);
                      },
                      child: const Text('Save split'),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _SplitLeg {
  String method;
  final TextEditingController ctl;
  _SplitLeg({required this.method, required this.ctl});
}
