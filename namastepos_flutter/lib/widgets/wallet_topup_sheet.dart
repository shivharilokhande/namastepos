// NamastePOS — "Top up wallet" bottom sheet (2026-09-06, round 3 Bug 1b).
//
// Shown from both checkouts (Pay & place + captain settle) when the diner's
// wallet cannot cover the due: the cashier takes ₹X in cash/UPI/card, the
// wallet is credited via POST /customers/:id/wallet/topup, and the caller
// re-reads the balance so the wallet toggle / shortfall maths re-evaluate.
//
// Returns the NEW wallet balance in ₹ on success, null when dismissed or the
// top-up failed (error already shown). Gate at the call site on the `loyalty`
// plan key (CheckoutGates.loyalty) — the endpoint 402s without it.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:uuid/uuid.dart';

import '../constants/colors.dart';
import '../services/api_service.dart';
import '../utils/error_humanizer.dart';
import '../utils/formatters.dart';

Future<double?> showWalletTopUpSheet(
  BuildContext context, {
  required String businessId,
  required String customerId,
  /// Pre-filled amount — typically the shortfall (due − balance) so one tap
  /// covers the bill exactly.
  double? suggestedInr,
  double currentBalanceInr = 0,
}) {
  return showModalBottomSheet<double>(
    context: context,
    isScrollControlled: true,
    builder: (_) => _WalletTopUpSheet(
      businessId: businessId,
      customerId: customerId,
      suggestedInr: suggestedInr,
      currentBalanceInr: currentBalanceInr,
    ),
  );
}

class _WalletTopUpSheet extends StatefulWidget {
  final String businessId;
  final String customerId;
  final double? suggestedInr;
  final double currentBalanceInr;
  const _WalletTopUpSheet({
    required this.businessId,
    required this.customerId,
    required this.suggestedInr,
    required this.currentBalanceInr,
  });

  @override
  State<_WalletTopUpSheet> createState() => _WalletTopUpSheetState();
}

class _WalletTopUpSheetState extends State<_WalletTopUpSheet> {
  late final TextEditingController _amount;
  String _method = 'cash';
  bool _busy = false;
  // One idempotency key per sheet instance: a retry after a timeout replays
  // instead of crediting twice (NP-401).
  final _key = const Uuid().v4();

  @override
  void initState() {
    super.initState();
    final s = widget.suggestedInr;
    _amount = TextEditingController(
        text: s != null && s > 0 ? s.toStringAsFixed(2) : '');
  }

  @override
  void dispose() {
    _amount.dispose();
    super.dispose();
  }

  double get _amountInr => double.tryParse(_amount.text.trim()) ?? 0;

  Future<void> _submit() async {
    final amt = _amountInr;
    if (amt <= 0 || _busy) return;
    setState(() => _busy = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      var bal = await ApiService.instance.topUpWallet(
        widget.businessId,
        widget.customerId,
        amountInr: amt,
        method: _method,
        note: 'Top-up at billing',
        idempotencyKey: _key,
      );
      // Reply without a balance → read it back so the caller always gets the
      // server's number, never a client-side guess.
      if (bal == null) {
        final w = await ApiService.instance
            .walletFor(widget.businessId, widget.customerId);
        bal = (w?['balanceInr'] as num?)?.toDouble();
      }
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(
        content: Text('Wallet topped up ${AppFmt.money(amt, decimals: true)} '
            'via ${_method.toUpperCase()}'
            '${bal != null ? ' — balance ${AppFmt.money(bal, decimals: true)}' : ''}'),
        backgroundColor: AppColors.success,
      ));
      Navigator.pop(context, bal ?? (widget.currentBalanceInr + amt));
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      messenger.showSnackBar(SnackBar(
          content: Text(humanizeError(e)), backgroundColor: AppColors.error));
    }
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
              Row(children: [
                const Icon(Icons.account_balance_wallet_outlined,
                    color: AppColors.primary),
                const SizedBox(width: 8),
                const Text('Top up wallet',
                    style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
                const Spacer(),
                Text('Now ${AppFmt.money(widget.currentBalanceInr, decimals: true)}',
                    style: const TextStyle(
                        color: AppColors.textSecondary,
                        fontWeight: FontWeight.w700)),
              ]),
              const SizedBox(height: 4),
              const Text(
                'Collect the amount from the customer; it is credited to their '
                'wallet and the bill is paid from the wallet.',
                style: TextStyle(fontSize: 12, color: AppColors.textSecondary),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _amount,
                autofocus: true,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                inputFormatters: [
                  FilteringTextInputFormatter.allow(RegExp(r'[0-9.]')),
                ],
                decoration: const InputDecoration(
                  labelText: 'Amount (₹)',
                  border: OutlineInputBorder(),
                  isDense: true,
                ),
                onChanged: (_) => setState(() {}),
              ),
              const SizedBox(height: 10),
              const Text('Collected via',
                  style: TextStyle(
                      fontSize: 12,
                      color: AppColors.textSecondary,
                      fontWeight: FontWeight.w700)),
              const SizedBox(height: 6),
              Wrap(
                spacing: 8,
                children: [
                  for (final m in const ['cash', 'upi', 'card'])
                    ChoiceChip(
                      label: Text(m.toUpperCase()),
                      selected: _method == m,
                      selectedColor: AppColors.primary,
                      labelStyle: TextStyle(
                        color: _method == m ? Colors.white : AppColors.textPrimary,
                        fontWeight: FontWeight.w600,
                      ),
                      onSelected: (_) => setState(() => _method = m),
                    ),
                ],
              ),
              const SizedBox(height: 14),
              Row(children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: _busy ? null : () => Navigator.pop(context, null),
                    child: const Text('Cancel'),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: ElevatedButton(
                    onPressed: (_amountInr <= 0 || _busy) ? null : _submit,
                    child: _busy
                        ? const SizedBox(
                            width: 18, height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2))
                        : Text(_amountInr > 0
                            ? 'Add ${AppFmt.money(_amountInr, decimals: true)}'
                            : 'Add'),
                  ),
                ),
              ]),
            ],
          ),
        ),
      ),
    );
  }
}
