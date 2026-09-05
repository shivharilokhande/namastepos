// NamastePOS mobile — "paste your menu" (2026-09-05).
//
// Mobile port of namastepos_dashboard/src/components/MenuPasteDialog.tsx.
//
// WHY IT EXISTS: the CSV importer and the /migrate wizard both assume the
// owner HAS an export from a previous system. A first-time owner, or one
// moving off paper, has nothing to export. What they DO have — and on a phone
// this is almost always true — is the menu as TEXT: the WhatsApp message they
// send regulars, a typed list, a note on their phone. This takes that text.
//
// NOT OCR. A photo of a menu card is explicitly out of scope and the screen
// says so: a half-working OCR over a phone photo produces confident wrong
// prices, and a wrong price is worse than no menu.
//
// THREE HONEST STEPS:
//   1. Paste. The SERVER parses (POST /menu/parse-text) and returns a preview.
//      It writes nothing. There is deliberately no parser in this file — one
//      regex set that lives in two languages is one regex set that will
//      disagree with itself, and the owner would get different rows on the
//      phone than on the web from the same text.
//   2. Correct. Every name, price and category is editable, low-confidence
//      rows are flagged, and every line the parser could NOT read is listed so
//      nothing disappears quietly. That list is the difference between a tool
//      an owner trusts and one that silently swallows three dishes.
//   3. Import. The confirmed rows go through the EXISTING POST /menu/bulk, so
//      the plan-cap pre-check (Starter 60 items, Growth unlimited) and the
//      all-or-nothing transaction apply exactly as they do for a CSV. A
//      template or paste that would blow the cap is refused whole, with the
//      standard 403 PLAN_LIMIT — never half-imported.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../providers/auth_provider.dart';
import '../../providers/menu_provider.dart';
import '../../services/api_service.dart';
import '../../utils/error_humanizer.dart';

const _example = '''STARTERS
Paneer Tikka 250
Masala Chai - 20
2. Butter Naan .... 40

Main Course:
Dal Makhani Rs 260
Butter Chicken 400''';

/// One parsed row, held as strings so a field can be empty mid-edit without
/// the row vanishing under the owner's finger.
class _Row {
  _Row({
    required String name,
    required String price,
    required String category,
    required this.confidence,
    this.note,
  })  : nameCtrl = TextEditingController(text: name),
        priceCtrl = TextEditingController(text: price),
        categoryCtrl = TextEditingController(text: category);

  final TextEditingController nameCtrl;
  final TextEditingController priceCtrl;
  final TextEditingController categoryCtrl;

  /// 'high' | 'low' — the server's own read of how sure it is about this line.
  final String confidence;

  /// Why it is unsure, in the server's words. Shown verbatim.
  final String? note;

  String get name => nameCtrl.text.trim();
  String get category => categoryCtrl.text.trim();
  double? get price => double.tryParse(priceCtrl.text.trim());

  /// Importable = has a name and a price that is a real number >= 0.
  bool get usable => name.isNotEmpty && (price != null) && price! >= 0;

  void dispose() {
    nameCtrl.dispose();
    priceCtrl.dispose();
    categoryCtrl.dispose();
  }
}

class MenuPasteScreen extends StatefulWidget {
  const MenuPasteScreen({super.key});

  @override
  State<MenuPasteScreen> createState() => _MenuPasteScreenState();
}

class _MenuPasteScreenState extends State<MenuPasteScreen> {
  final _text = TextEditingController();

  List<_Row>? _rows;
  List<Map<String, dynamic>> _unparsed = const [];
  bool _parsing = false;
  bool _importing = false;
  Map<String, dynamic>? _result;

  /// Everything this visit put into the menu, across repeat imports. Handed
  /// back to whoever pushed this screen on either exit.
  int _insertedTotal = 0;

  @override
  void dispose() {
    _text.dispose();
    for (final r in _rows ?? const <_Row>[]) {
      r.dispose();
    }
    super.dispose();
  }

  String? get _businessId => context.read<AuthProvider>().business?.id;

  Future<void> _parse() async {
    final bid = _businessId;
    final text = _text.text.trim();
    if (bid == null || text.isEmpty || _parsing) return;
    FocusScope.of(context).unfocus();
    setState(() { _parsing = true; _result = null; });
    try {
      final r = await ApiService.instance.parseMenuText(bid, text);
      if (!mounted) return;
      final parsed = (r['items'] as List? ?? const [])
          .map((e) => (e as Map).cast<String, dynamic>())
          .map((i) => _Row(
                name: '${i['name'] ?? ''}',
                price: '${i['price'] ?? ''}',
                category: '${i['category'] ?? 'Menu'}',
                confidence: '${i['confidence'] ?? 'high'}',
                note: i['note'] as String?,
              ))
          .toList();
      // Dispose the previous preview's controllers — a second "Read the menu"
      // on a corrected paste would otherwise leak one controller per row.
      // AFTER the frame, never before: the old TextFields are still mounted
      // until this setState's rebuild completes, and a controller disposed
      // out from under a live field throws on unmount.
      final stale = _rows;
      if (stale != null) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          for (final old in stale) {
            old.dispose();
          }
        });
      }
      setState(() {
        _rows = parsed;
        _unparsed = (r['unparsed'] as List? ?? const [])
            .map((e) => (e as Map).cast<String, dynamic>())
            .toList();
        _parsing = false;
      });
      if (parsed.isEmpty && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          backgroundColor: AppColors.error,
          content: Text("Couldn't read any items. Each line needs a name and "
              'a price, like: Paneer Tikka 250'),
        ));
      }
    } catch (e) {
      if (!mounted) return;
      setState(() => _parsing = false);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        backgroundColor: AppColors.error,
        content: Text(humanizeError(e)),
      ));
    }
  }

  Future<void> _import() async {
    final bid = _businessId;
    final rows = _rows;
    if (bid == null || rows == null || _importing) return;
    final payload = rows
        .where((r) => r.usable)
        .map((r) => <String, dynamic>{
              'name': r.name,
              'price': r.price,
              // The parser always supplies a category; this only catches an
              // owner who cleared the field while editing.
              'category': r.category.isEmpty ? 'Menu' : r.category,
            })
        .toList();
    if (payload.isEmpty) return;
    FocusScope.of(context).unfocus();
    setState(() => _importing = true);
    try {
      final r = await ApiService.instance.bulkImportMenu(bid, payload);
      if (!mounted) return;
      final inserted = (r['inserted'] as num?)?.toInt() ?? 0;
      setState(() {
        _result = r;
        _importing = false;
        _insertedTotal += inserted;
      });
      if (inserted > 0) {
        // Same contract as the template screen and as the dashboard: refresh
        // from the server, attributing `menu_ready` to this route.
        await context.read<MenuProvider>().load(bid, source: 'paste');
        if (!mounted) return;
        final skipped = (r['skipped'] as num?)?.toInt() ?? 0;
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          backgroundColor: AppColors.success,
          content: Text('$inserted item${inserted == 1 ? '' : 's'} added'
              '${skipped > 0 ? ' · $skipped skipped' : ''}'),
        ));
      }
    } catch (e) {
      if (!mounted) return;
      setState(() => _importing = false);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        backgroundColor: AppColors.error,
        content: Text(humanizeError(e)),
      ));
    }
  }

  void _drop(int i) {
    final rows = _rows;
    if (rows == null) return;
    final removed = rows[i];
    setState(() => rows.removeAt(i));
    // Controllers are gone from the list, so state dispose() would leak them.
    WidgetsBinding.instance.addPostFrameCallback((_) => removed.dispose());
  }

  @override
  Widget build(BuildContext context) {
    final rows = _rows;
    final usable = rows?.where((r) => r.usable).length ?? 0;
    final lowConfidence =
        rows?.where((r) => r.confidence == 'low').length ?? 0;

    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        title: const Text('Paste your menu'),
        // Popping with the inserted count lets a caller (the setup wizard)
        // know something landed without re-reading the menu itself. BOTH exits
        // carry it: an owner who imports and then hits the system back arrow
        // must not look to the wizard like an owner who imported nothing.
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => Navigator.of(context).pop(_insertedTotal),
        ),
        actions: [
          if (_result != null)
            TextButton(
              onPressed: () => Navigator.of(context).pop(_insertedTotal),
              child: const Text('Done'),
            ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(14, 12, 14, 28),
        children: [
          _stepLabel('Step 1 · Paste the text'),
          const SizedBox(height: 6),
          TextField(
            controller: _text,
            maxLines: 8,
            minLines: 6,
            keyboardType: TextInputType.multiline,
            textCapitalization: TextCapitalization.sentences,
            style: const TextStyle(fontSize: 13, fontFamily: 'monospace'),
            decoration: InputDecoration(
              hintText: _example,
              hintStyle: const TextStyle(
                  fontSize: 12, color: AppColors.textHint, height: 1.4),
              filled: true,
              fillColor: AppColors.surface,
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(10),
                borderSide: const BorderSide(color: AppColors.divider),
              ),
            ),
          ),
          const SizedBox(height: 8),
          const Text(
            'Works with a WhatsApp message, a typed list, numbered lines, '
            'dotted leaders and ₹ / Rs. A line that is only a heading '
            '("STARTERS", "Main Course:") becomes a category. A photo of a '
            'menu card will not work — type or paste the text.',
            style: TextStyle(fontSize: 11, color: AppColors.textSecondary),
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              OutlinedButton.icon(
                onPressed: _parsing ? null : _pasteFromClipboard,
                icon: const Icon(Icons.content_paste, size: 16),
                label: const Text('Paste from clipboard'),
              ),
              const Spacer(),
              ElevatedButton(
                onPressed: _parsing ? null : _parse,
                child: _parsing
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(
                            strokeWidth: 2, color: Colors.white))
                    : const Text('Read the menu'),
              ),
            ],
          ),

          // ── Step 2 — correct ────────────────────────────────────────────
          if (rows != null && rows.isNotEmpty) ...[
            const SizedBox(height: 20),
            _stepLabel('Step 2 · Check and fix '
                '($usable item${usable == 1 ? '' : 's'})'),
            if (lowConfidence > 0) ...[
              const SizedBox(height: 6),
              Row(
                children: [
                  const Icon(Icons.warning_amber_rounded,
                      size: 14, color: AppColors.warning),
                  const SizedBox(width: 5),
                  Expanded(
                    child: Text(
                      '$lowConfidence row${lowConfidence == 1 ? '' : 's'} we '
                      'are not sure about — highlighted below.',
                      style: const TextStyle(
                          fontSize: 11, color: AppColors.warning),
                    ),
                  ),
                ],
              ),
            ],
            const SizedBox(height: 8),
            for (var i = 0; i < rows.length; i++) _editRow(rows[i], i),
            const SizedBox(height: 12),
            SizedBox(
              width: double.infinity,
              child: ElevatedButton.icon(
                onPressed: (usable == 0 || _importing) ? null : _import,
                icon: _importing
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(
                            strokeWidth: 2, color: Colors.white))
                    : const Icon(Icons.file_upload_outlined, size: 18),
                label: Text(_importing
                    ? 'Importing…'
                    : 'Add $usable item${usable == 1 ? '' : 's'} to my menu'),
              ),
            ),
          ],

          // ── Lines we could not read — never hidden ──────────────────────
          if (_unparsed.isNotEmpty) ...[
            const SizedBox(height: 16),
            _unparsedCard(),
          ],

          // ── Result ──────────────────────────────────────────────────────
          if (_result != null) ...[
            const SizedBox(height: 16),
            _resultCard(_result!),
          ],
        ],
      ),
    );
  }

  Future<void> _pasteFromClipboard() async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    final t = data?.text;
    if (t == null || t.trim().isEmpty) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text('Nothing text-like on the clipboard.'),
      ));
      return;
    }
    setState(() => _text.text = t);
  }

  Widget _stepLabel(String s) => Text(
        s.toUpperCase(),
        style: const TextStyle(
          fontSize: 10,
          fontWeight: FontWeight.w800,
          letterSpacing: 0.5,
          color: AppColors.textSecondary,
        ),
      );

  Widget _editRow(_Row r, int i) {
    final low = r.confidence == 'low';
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.fromLTRB(10, 8, 4, 8),
      decoration: BoxDecoration(
        color: low
            ? AppColors.warning.withValues(alpha: 0.08)
            : AppColors.surface,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(
            color: low
                ? AppColors.warning.withValues(alpha: 0.45)
                : AppColors.divider),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                flex: 5,
                child: TextField(
                  controller: r.nameCtrl,
                  onChanged: (_) => setState(() {}),
                  style: const TextStyle(fontSize: 13),
                  decoration: const InputDecoration(
                      isDense: true, hintText: 'Item name'),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                flex: 2,
                child: TextField(
                  controller: r.priceCtrl,
                  onChanged: (_) => setState(() {}),
                  keyboardType:
                      const TextInputType.numberWithOptions(decimal: true),
                  style: const TextStyle(fontSize: 13),
                  decoration:
                      const InputDecoration(isDense: true, hintText: '₹'),
                ),
              ),
              IconButton(
                icon: const Icon(Icons.close, size: 17),
                tooltip: "Don't import this line",
                color: AppColors.error,
                onPressed: () => _drop(i),
              ),
            ],
          ),
          Padding(
            padding: const EdgeInsets.only(right: 44),
            child: TextField(
              controller: r.categoryCtrl,
              style: const TextStyle(
                  fontSize: 12, color: AppColors.textSecondary),
              decoration: const InputDecoration(
                  isDense: true, hintText: 'Category'),
            ),
          ),
          if (r.note != null && r.note!.isNotEmpty) ...[
            const SizedBox(height: 5),
            Padding(
              padding: const EdgeInsets.only(right: 44),
              child: Text(r.note!,
                  style: const TextStyle(
                      fontSize: 11, color: AppColors.warning, height: 1.3)),
            ),
          ],
        ],
      ),
    );
  }

  Widget _unparsedCard() {
    final n = _unparsed.length;
    final shown = _unparsed.take(20).toList();
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppColors.warning.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppColors.warning.withValues(alpha: 0.4)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.info_outline,
                  size: 14, color: AppColors.warning),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  '$n line${n == 1 ? '' : 's'} we could not read',
                  style: const TextStyle(
                      fontSize: 12, fontWeight: FontWeight.w800),
                ),
              ),
            ],
          ),
          const SizedBox(height: 5),
          const Text(
            'Nothing was guessed for these. Add them by hand, or fix the line '
            'and read the menu again.',
            style: TextStyle(fontSize: 11, color: AppColors.textSecondary),
          ),
          const SizedBox(height: 7),
          for (final u in shown)
            Padding(
              padding: const EdgeInsets.only(bottom: 3),
              child: Text(
                '${(u['line'] as String?)?.isNotEmpty == true
                    ? u['line']
                    : '(blank)'} — ${u['reason'] ?? ''}',
                style: const TextStyle(fontSize: 11, height: 1.3),
              ),
            ),
          if (n > 20)
            Text('… and ${n - 20} more',
                style: const TextStyle(
                    fontSize: 11, color: AppColors.textSecondary)),
        ],
      ),
    );
  }

  Widget _resultCard(Map<String, dynamic> r) {
    final inserted = (r['inserted'] as num?)?.toInt() ?? 0;
    final skipped = (r['skipped'] as num?)?.toInt() ?? 0;
    final errors = (r['errors'] as List? ?? const [])
        .map((e) => (e as Map).cast<String, dynamic>())
        .toList();
    final ok = errors.isEmpty && inserted > 0;
    final color = ok ? AppColors.success : AppColors.warning;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: color.withValues(alpha: 0.4)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '$inserted item${inserted == 1 ? '' : 's'} added'
            '${skipped > 0 ? ' · $skipped skipped' : ''}',
            style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 13),
          ),
          if (errors.isNotEmpty) ...[
            const SizedBox(height: 6),
            for (final e in errors.take(15))
              Padding(
                padding: const EdgeInsets.only(bottom: 2),
                child: Text(
                  'Row ${e['row']}'
                  '${e['name'] != null ? ' (${e['name']})' : ''}: '
                  '${e['message'] ?? ''}',
                  style: const TextStyle(fontSize: 11, height: 1.3),
                ),
              ),
          ],
        ],
      ),
    );
  }
}
