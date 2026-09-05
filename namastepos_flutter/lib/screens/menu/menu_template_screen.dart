// NamastePOS mobile — starter menu picker (2026-09-05).
//
// Mobile port of namastepos_dashboard/src/components/MenuTemplateDialog.tsx.
// Same three endpoints, same merge semantics, same warnings — a feature that
// behaves differently on the phone than on the web is a feature owners stop
// trusting on both.
//
// Flow: pick a kind of kitchen -> read the actual items and prices -> Load.
// Nothing is hidden behind the button: an owner about to put 34 rows into
// their menu gets to read them first, GST slabs included, because a template
// they cannot inspect is a template they will not tap.
//
// LOADING IS A MERGE. Items whose names the business already has are left
// completely alone — not re-priced, not removed — and reported back in
// `alreadyPresent`. Loading the same template twice does nothing the second
// time, which is what makes a double-tap on a flaky café connection safe. The
// screen says so BEFORE the owner taps, because "will this wipe what I typed?"
// is the first question anyone asks.
//
// NO PRICES ARE SENT. The client posts a slug and nothing else; every name,
// price, category, GST slab and HSN code comes off the server's own disk.
//
// PLAN CAP. The server dedupes first and then measures the surviving rows
// against the plan's menu-item cap (Starter is 60, Growth unlimited — verified
// live against GET /v1/public/plans on 2026-09-05) BEFORE writing a single
// row, and throws the standard 403 PLAN_LIMIT for the whole template. There is
// no half-import to clean up, so this screen just shows the server's message.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../providers/auth_provider.dart';
import '../../providers/menu_provider.dart';
import '../../services/api_service.dart';
import '../../utils/error_humanizer.dart';
import '../../utils/formatters.dart';

class MenuTemplateScreen extends StatefulWidget {
  const MenuTemplateScreen({super.key});

  @override
  State<MenuTemplateScreen> createState() => _MenuTemplateScreenState();
}

class _MenuTemplateScreenState extends State<MenuTemplateScreen> {
  List<Map<String, dynamic>>? _list;
  String? _listError;
  bool _loadingList = true;

  String? _slug;
  Map<String, dynamic>? _detail;
  bool _loadingDetail = false;
  String? _detailError;

  bool _applying = false;

  @override
  void initState() {
    super.initState();
    _fetchList();
  }

  String? get _businessId => context.read<AuthProvider>().business?.id;

  Future<void> _fetchList() async {
    final bid = _businessId;
    if (bid == null) {
      setState(() { _loadingList = false; _listError = 'Not signed in'; });
      return;
    }
    setState(() { _loadingList = true; _listError = null; });
    try {
      final raw = await ApiService.instance.listMenuTemplates(bid);
      if (!mounted) return;
      setState(() {
        _list = raw
            .map((e) => (e as Map).cast<String, dynamic>())
            .toList(growable: false);
        _loadingList = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() { _loadingList = false; _listError = humanizeError(e); });
    }
  }

  Future<void> _open(String slug) async {
    final bid = _businessId;
    if (bid == null) return;
    setState(() {
      _slug = slug; _detail = null; _loadingDetail = true; _detailError = null;
    });
    try {
      final t = await ApiService.instance.getMenuTemplate(bid, slug);
      if (!mounted || _slug != slug) return;
      setState(() { _detail = t; _loadingDetail = false; });
    } catch (e) {
      if (!mounted || _slug != slug) return;
      setState(() { _loadingDetail = false; _detailError = humanizeError(e); });
    }
  }

  Future<void> _apply() async {
    final bid = _businessId;
    final slug = _slug;
    if (bid == null || slug == null || _applying) return;
    setState(() => _applying = true);
    try {
      final r = await ApiService.instance.applyMenuTemplate(bid, slug);
      final inserted = (r['inserted'] as num?)?.toInt() ?? 0;
      final already = (r['alreadyPresent'] as List?)?.length ?? 0;
      if (!mounted) return;

      if (inserted > 0) {
        // Pull the real menu back from the server and attribute `menu_ready`
        // to this route. The provider only fires the milestone on the refresh
        // that crosses the 3-item threshold, so this is cheap on every other
        // apply. Source string is byte-identical to the dashboard's.
        await context.read<MenuProvider>().load(bid, source: 'template');
        if (!mounted) return;
        // Grab the messenger BEFORE popping: after the pop this State's
        // context is defunct, and ScaffoldMessenger.of() on it would either
        // throw or post the message to nothing. The messenger itself belongs
        // to the enclosing navigator and outlives this route.
        final messenger = ScaffoldMessenger.of(context);
        Navigator.of(context).pop(inserted);
        messenger.showSnackBar(SnackBar(
          backgroundColor: AppColors.success,
          content: Text(
            '$inserted item${inserted == 1 ? '' : 's'} added'
            '${already > 0 ? ' · $already you already had were left alone' : ''}'
            '. Tap any item to change its price.',
          ),
        ));
      } else {
        setState(() => _applying = false);
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('You already have every item in this menu. '
              'Nothing changed.'),
        ));
      }
    } catch (e) {
      if (!mounted) return;
      setState(() => _applying = false);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        backgroundColor: AppColors.error,
        content: Text(humanizeError(e)),
      ));
    }
  }

  @override
  Widget build(BuildContext context) {
    final d = _detail;
    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        title: Text(_slug != null && d != null
            ? (d['name'] as String? ?? 'Menu')
            : 'Start with a menu'),
        leading: _slug != null
            ? IconButton(
                icon: const Icon(Icons.arrow_back),
                tooltip: 'Back to the list',
                onPressed: _applying
                    ? null
                    : () => setState(() { _slug = null; _detail = null; }),
              )
            : null,
      ),
      body: _slug == null ? _listBody() : _detailBody(),
      bottomNavigationBar: (_slug != null && d != null) ? _applyBar(d) : null,
    );
  }

  // ── The picker ──────────────────────────────────────────────────────────

  Widget _listBody() {
    if (_loadingList) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_listError != null) {
      return _retry("Couldn't load the starter menus.", _listError!, _fetchList);
    }
    final list = _list ?? const <Map<String, dynamic>>[];
    if (list.isEmpty) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text('No starter menus available right now.',
              textAlign: TextAlign.center,
              style: TextStyle(color: AppColors.textSecondary)),
        ),
      );
    }
    return ListView(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 24),
      children: [
        const Text(
          'Pick the closest kind of kitchen. Items, categories and GST come '
          'pre-filled, and you can change any price afterwards.',
          style: TextStyle(fontSize: 12, color: AppColors.textSecondary),
        ),
        const SizedBox(height: 12),
        ...list.map(_templateCard),
      ],
    );
  }

  Widget _templateCard(Map<String, dynamic> t) {
    final cats = (t['categories'] as List?)?.cast<Object?>() ?? const [];
    final shown = cats.take(5).map((c) => '$c').join(' · ');
    final count = (t['itemCount'] as num?)?.toInt() ?? 0;
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Material(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(12),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: () => _open(t['slug'] as String),
          child: Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: AppColors.divider),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: Text(t['name'] as String? ?? '',
                          style: const TextStyle(
                              fontWeight: FontWeight.w800, fontSize: 15)),
                    ),
                    Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(
                        color: AppColors.background,
                        borderRadius: BorderRadius.circular(10),
                      ),
                      child: Text('$count items',
                          style: const TextStyle(
                              fontSize: 11, color: AppColors.textSecondary)),
                    ),
                  ],
                ),
                if ((t['tagline'] as String?)?.isNotEmpty == true) ...[
                  const SizedBox(height: 4),
                  Text(t['tagline'] as String,
                      style: const TextStyle(
                          fontSize: 12, color: AppColors.textSecondary)),
                ],
                if (shown.isNotEmpty) ...[
                  const SizedBox(height: 8),
                  Text(
                    shown + (cats.length > 5 ? ' · …' : ''),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                        fontSize: 11, color: AppColors.textHint),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }

  // ── One template, in full ───────────────────────────────────────────────

  Widget _detailBody() {
    if (_loadingDetail) return const Center(child: CircularProgressIndicator());
    if (_detailError != null) {
      return _retry("Couldn't load this menu.", _detailError!,
          () => _open(_slug!));
    }
    final d = _detail;
    if (d == null) return const SizedBox.shrink();
    final notes = (d['notes'] as List?)?.map((n) => '$n').toList() ?? const [];
    final items = (d['items'] as List?)
            ?.map((e) => (e as Map).cast<String, dynamic>())
            .toList() ??
        const <Map<String, dynamic>>[];

    return ListView(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 24),
      children: [
        if (notes.isNotEmpty)
          _banner(
            color: AppColors.info,
            icon: Icons.info_outline,
            children: notes
                .map((n) => Text(n,
                    style: const TextStyle(fontSize: 12, height: 1.35)))
                .toList(),
          ),
        if (notes.isNotEmpty) const SizedBox(height: 10),
        _banner(
          color: AppColors.warning,
          icon: Icons.warning_amber_rounded,
          children: const [
            Text(
              'Nothing you already have is touched. Items with a name you '
              'already use are skipped, not re-priced or removed. Load it '
              'twice and the second time does nothing.',
              style: TextStyle(fontSize: 12, height: 1.35),
            ),
          ],
        ),
        const SizedBox(height: 12),
        Text('${items.length} items · edit any price after loading',
            style: const TextStyle(
                fontSize: 11,
                color: AppColors.textHint,
                fontWeight: FontWeight.w600)),
        const SizedBox(height: 6),
        Container(
          decoration: BoxDecoration(
            color: AppColors.surface,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: AppColors.divider),
          ),
          child: Column(
            children: [
              for (var i = 0; i < items.length; i++) ...[
                if (i > 0) const Divider(height: 1),
                _itemRow(items[i]),
              ],
            ],
          ),
        ),
      ],
    );
  }

  Widget _itemRow(Map<String, dynamic> it) {
    final isVeg = it['isVeg'] != false;
    final price = (it['price'] as num?)?.toDouble() ?? 0;
    final gst = it['gstPct'];
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
      child: Row(
        children: [
          Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: isVeg ? AppColors.success : AppColors.error,
            ),
          ),
          const SizedBox(width: 9),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(it['name'] as String? ?? '',
                    style: const TextStyle(
                        fontSize: 13, fontWeight: FontWeight.w600)),
                Text(it['category'] as String? ?? '',
                    style: const TextStyle(
                        fontSize: 11, color: AppColors.textHint)),
              ],
            ),
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(AppFmt.money(price),
                  style: const TextStyle(
                      fontSize: 13, fontWeight: FontWeight.w700)),
              Text('GST ${gst ?? 0}%',
                  style: const TextStyle(
                      fontSize: 10, color: AppColors.textHint)),
            ],
          ),
        ],
      ),
    );
  }

  Widget _applyBar(Map<String, dynamic> d) {
    final count = (d['itemCount'] as num?)?.toInt() ?? 0;
    return SafeArea(
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: const BoxDecoration(
          color: AppColors.surface,
          border: Border(top: BorderSide(color: AppColors.divider)),
        ),
        child: Row(
          children: [
            TextButton(
              onPressed: _applying
                  ? null
                  : () => setState(() { _slug = null; _detail = null; }),
              child: const Text('Pick another'),
            ),
            const Spacer(),
            ElevatedButton.icon(
              onPressed: _applying ? null : _apply,
              icon: _applying
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(
                          strokeWidth: 2, color: Colors.white))
                  : const Icon(Icons.check, size: 18),
              label: Text(_applying ? 'Loading…' : 'Load these $count items'),
            ),
          ],
        ),
      ),
    );
  }

  // ── Shared bits ─────────────────────────────────────────────────────────

  Widget _banner({
    required Color color,
    required IconData icon,
    required List<Widget> children,
  }) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: color.withValues(alpha: 0.35)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 15, color: color),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (var i = 0; i < children.length; i++) ...[
                  if (i > 0) const SizedBox(height: 5),
                  children[i],
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _retry(String title, String detail, VoidCallback onRetry) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(title,
                textAlign: TextAlign.center,
                style: const TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 6),
            Text(detail,
                textAlign: TextAlign.center,
                style: const TextStyle(
                    fontSize: 12, color: AppColors.textSecondary)),
            const SizedBox(height: 14),
            OutlinedButton(onPressed: onRetry, child: const Text('Try again')),
          ],
        ),
      ),
    );
  }
}
