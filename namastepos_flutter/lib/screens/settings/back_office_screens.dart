// NamastePOS — Mobile back-office settings (Batch I).
//
// Five lightweight read-mostly screens consolidated in one file so the
// drawer entries stay easy to scan: Surge rules · Memberships · QR codes ·
// Bill template editor · Image upload. Each backs onto an existing
// backend endpoint we exposed in api_service.dart.

import 'dart:io' show File;

import 'package:dio/dio.dart' show FormData, MultipartFile;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show Clipboard, ClipboardData;
import 'package:provider/provider.dart';
import 'package:image_picker/image_picker.dart';

import 'members_screen.dart';

import '../../constants/colors.dart';
import '../../utils/error_humanizer.dart';
import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../../utils/formatters.dart';
import '../../widgets/home_bottom_nav.dart';
import '../../widgets/home_drawer_button.dart';
import '../../widgets/membership_plan_dialog.dart';

// ── Surge pricing (read-only view) ─────────────────────────────────────
class SurgeRulesScreen extends StatefulWidget {
  const SurgeRulesScreen({super.key});
  @override State<SurgeRulesScreen> createState() => _SurgeRulesScreenState();
}

class _SurgeRulesScreenState extends State<SurgeRulesScreen> {
  List<dynamic> _rules = [];
  bool _loading = true;
  @override void initState() { super.initState(); _load(); }
  Future<void> _load() async {
    final biz = context.read<AuthProvider>().business;
    if (biz == null) { setState(() => _loading = false); return; }
    try { _rules = await ApiService.instance.listSurgeRules(biz.id); }
    catch (e) { debugPrint('SurgeRulesScreen.load: $e'); }
    if (mounted) setState(() => _loading = false);
  }
  static const _days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  String _hhmm(int min) {
    final h = min ~/ 60, m = min % 60;
    return '${h.toString().padLeft(2, '0')}:${m.toString().padLeft(2, '0')}';
  }

  /// Add/edit-rule dialog (2026-08-22; edit + delete added 2026-08-23).
  /// Owner-only on the backend; errors surface as snackbars.
  Future<void> _addRule([Map<String, dynamic>? existing]) async {
    final biz = context.read<AuthProvider>().business;
    if (biz == null) return;
    final name =
        TextEditingController(text: existing?['name']?.toString() ?? '');
    final multiplier = TextEditingController(
        text: existing?['multiplier']?.toString() ?? '1.2');
    int? dayOfWeek = existing?['day_of_week'] as int?; // null = any day
    TimeOfDay _fromMin(int m) => TimeOfDay(hour: m ~/ 60, minute: m % 60);
    TimeOfDay start = existing != null
        ? _fromMin((existing['start_minute'] as num).toInt())
        : const TimeOfDay(hour: 19, minute: 0);
    TimeOfDay end = existing != null
        ? _fromMin((existing['end_minute'] as num).toInt())
        : const TimeOfDay(hour: 22, minute: 0);
    final ok = await showDialog<bool>(
      context: context,
      builder: (dCtx) => StatefulBuilder(
        builder: (dCtx, setDState) => AlertDialog(
          title: Text(existing == null ? 'New surge rule' : 'Edit surge rule'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(
                    controller: name,
                    decoration: const InputDecoration(
                        labelText: 'Name (e.g. Weekend dinner rush)')),
                const SizedBox(height: 8),
                DropdownButtonFormField<int?>(
                  value: dayOfWeek,
                  decoration: const InputDecoration(labelText: 'Day'),
                  items: [
                    const DropdownMenuItem<int?>(
                        value: null, child: Text('Any day')),
                    for (var i = 0; i < 7; i++)
                      DropdownMenuItem<int?>(
                          value: i, child: Text(_days[i])),
                  ],
                  onChanged: (v) => setDState(() => dayOfWeek = v),
                ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    Expanded(
                      child: OutlinedButton(
                        onPressed: () async {
                          final t = await showTimePicker(
                              context: dCtx, initialTime: start);
                          if (t != null) setDState(() => start = t);
                        },
                        child: Text('From ${start.format(dCtx)}'),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: OutlinedButton(
                        onPressed: () async {
                          final t = await showTimePicker(
                              context: dCtx, initialTime: end);
                          if (t != null) setDState(() => end = t);
                        },
                        child: Text('To ${end.format(dCtx)}'),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                TextField(
                    controller: multiplier,
                    keyboardType: const TextInputType.numberWithOptions(
                        decimal: true),
                    decoration: const InputDecoration(
                        labelText: 'Multiplier (e.g. 1.2 = +20%)')),
              ],
            ),
          ),
          actions: [
            TextButton(
                onPressed: () => Navigator.pop(dCtx, false),
                child: const Text('Cancel')),
            ElevatedButton(
                onPressed: () => Navigator.pop(dCtx, true),
                child: const Text('Save rule')),
          ],
        ),
      ),
    );
    if (ok != true || !mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    try {
      final body = {
        'name': name.text.trim(),
        'dayOfWeek': dayOfWeek,
        'startMinute': start.hour * 60 + start.minute,
        'endMinute': end.hour * 60 + end.minute,
        'multiplier': double.tryParse(multiplier.text) ?? 1.0,
      };
      if (existing == null) {
        await ApiService.instance.createSurgeRule(biz.id, body);
      } else {
        await ApiService.instance
            .updateSurgeRule(biz.id, existing['id'] as String, body);
      }
      messenger.showSnackBar(
          const SnackBar(content: Text('Surge rule saved ✓')));
      await _load();
    } catch (e) {
      messenger.showSnackBar(SnackBar(
          content: Text(humanizeError(e)),
          backgroundColor: AppColors.error));
    }
  }

  Future<void> _deleteRule(Map<String, dynamic> r) async {
    final biz = context.read<AuthProvider>().business;
    if (biz == null) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (dCtx) => AlertDialog(
        title: const Text('Delete surge rule?'),
        content: Text('"${r['name']}" will stop applying immediately.'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(dCtx, false),
              child: const Text('Cancel')),
          ElevatedButton(
              style: ElevatedButton.styleFrom(
                  backgroundColor: AppColors.error),
              onPressed: () => Navigator.pop(dCtx, true),
              child:
                  const Text('Delete', style: TextStyle(color: Colors.white))),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ApiService.instance.deleteSurgeRule(biz.id, r['id'] as String);
      messenger
          .showSnackBar(const SnackBar(content: Text('Surge rule deleted')));
      await _load();
    } catch (e) {
      messenger.showSnackBar(SnackBar(
          content: Text(humanizeError(e)),
          backgroundColor: AppColors.error));
    }
  }
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        leading: (ModalRoute.of(context)?.isFirst ?? true) ? const HomeDrawerButton() : null,
        title: const Text('Surge pricing')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _addRule,
        icon: const Icon(Icons.add),
        label: const Text('Add rule'),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _rules.isEmpty
              ? const Center(child: Padding(
                  padding: EdgeInsets.all(24),
                  child: Text('No surge rules yet. Tap "Add rule" to create '
                      'one — e.g. +20% on weekend dinner delivery.',
                      style: TextStyle(color: AppColors.textSecondary),
                      textAlign: TextAlign.center)))
              : ListView.separated(
                  itemCount: _rules.length,
                  separatorBuilder: (_, __) => const Divider(height: 1),
                  itemBuilder: (_, i) {
                    final r = _rules[i] as Map<String, dynamic>;
                    final day = r['day_of_week'] as int?;
                    return ListTile(
                      // Tap to edit (2026-08-23)
                      onTap: () => _addRule(r),
                      title: Text(r['name'] as String? ?? '?',
                          style: const TextStyle(fontWeight: FontWeight.w800)),
                      subtitle: Text(
                          '${day == null ? "Any day" : _days[day]} · '
                          '${_hhmm((r['start_minute'] as num).toInt())} → '
                          '${_hhmm((r['end_minute'] as num).toInt())} · tap to edit'),
                      trailing: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Container(
                            padding: const EdgeInsets.symmetric(
                                horizontal: 8, vertical: 4),
                            decoration: BoxDecoration(
                              color: AppColors.warning.withValues(alpha: 0.18),
                              borderRadius: BorderRadius.circular(6),
                            ),
                            child: Text('×${r['multiplier']}',
                                style: const TextStyle(
                                    color: AppColors.warning,
                                    fontWeight: FontWeight.w800)),
                          ),
                          IconButton(
                            icon: const Icon(Icons.delete_outline,
                                size: 20, color: AppColors.error),
                            onPressed: () => _deleteRule(r),
                          ),
                        ],
                      ),
                    );
                  },
                ),
      bottomNavigationBar: const HomeBottomNav(),
    );
  }
}

// ── Memberships (read-only list) ────────────────────────────────────────
class MembershipsScreen extends StatefulWidget {
  const MembershipsScreen({super.key});
  @override State<MembershipsScreen> createState() => _MembershipsScreenState();
}

class _MembershipsScreenState extends State<MembershipsScreen> {
  List<dynamic> _list = [];
  bool _loading = true;
  @override void initState() { super.initState(); _load(); }
  Future<void> _load() async {
    final biz = context.read<AuthProvider>().business;
    if (biz == null) { setState(() => _loading = false); return; }
    try { _list = await ApiService.instance.listMemberships(biz.id); }
    catch (e) { debugPrint('MembershipsScreen.load: $e'); }
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _confirmDelete(Map<String, dynamic> m) async {
    final biz = context.read<AuthProvider>().business;
    if (biz == null) return;
    final yes = await showDialog<bool>(
      context: context,
      builder: (dCtx) => AlertDialog(
        title: const Text('Delete plan?'),
        content: Text('Remove "${m['name'] ?? 'this plan'}"? Existing members '
            'keep their active subscriptions; the plan just stops being offered.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dCtx, false), child: const Text('Cancel')),
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: AppColors.error),
            onPressed: () => Navigator.pop(dCtx, true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (yes != true) return;
    try {
      await ApiService.instance.deleteMembership(biz.id, m['id'].toString());
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Plan deleted ✓')));
        await _load();
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(humanizeError(e)), backgroundColor: AppColors.error));
      }
    }
  }
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        leading: (ModalRoute.of(context)?.isFirst ?? true) ? const HomeDrawerButton() : null,
        title: const Text('Memberships'),
        actions: [
          IconButton(
            tooltip: 'Members',
            icon: const Icon(Icons.people_alt_outlined),
            onPressed: () => Navigator.push(context,
                MaterialPageRoute(builder: (_) => const MembersScreen())),
          ),
        ]),
      // 2026-08-23: plans (incl. item bundles) can be created right here.
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () async {
          final created = await showCreateMembershipPlanDialog(context);
          if (created && mounted) await _load();
        },
        icon: const Icon(Icons.add),
        label: const Text('New plan'),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _list.isEmpty
              ? const Center(
                  child: Text('No membership plans yet — tap "New plan" '
                      'to create a bundle like "20× Cold Coffee, 30 days".',
                      textAlign: TextAlign.center))
              : ListView.separated(
                  itemCount: _list.length,
                  separatorBuilder: (_, __) => const Divider(height: 1),
                  itemBuilder: (_, i) {
                    final m = _list[i] as Map<String, dynamic>;
                    final benefits = m['benefits'] as Map? ?? {};
                    return ListTile(
                      leading: const Icon(Icons.workspace_premium,
                          color: AppColors.warning),
                      title: Text(m['name'] as String? ?? '?',
                          style: const TextStyle(fontWeight: FontWeight.w800)),
                      subtitle: Text(
                          '${AppFmt.money(((m['price_paise'] as num?)?.toInt() ?? 0) / 100)}'
                          ' · ${m['validity_days']} days'
                          '${benefits['discount_pct'] != null ? " · ${benefits['discount_pct']}% off" : ""}'),
                      // 2026-08-24: full CRUD — tap to edit, delete via menu.
                      onTap: () async {
                        final saved = await showMembershipPlanDialog(context, existing: m);
                        if (saved && mounted) await _load();
                      },
                      trailing: PopupMenuButton<String>(
                        onSelected: (v) async {
                          if (v == 'edit') {
                            final saved = await showMembershipPlanDialog(context, existing: m);
                            if (saved && mounted) await _load();
                          } else if (v == 'delete') {
                            await _confirmDelete(m);
                          }
                        },
                        itemBuilder: (_) => const [
                          PopupMenuItem(value: 'edit', child: Text('Edit')),
                          PopupMenuItem(value: 'delete', child: Text('Delete')),
                        ],
                      ),
                    );
                  },
                ),
      bottomNavigationBar: const HomeBottomNav(),
    );
  }
}

// Push 16e — old read-only QrCodesScreen placeholder removed.
// Replaced by lib/screens/qr/qr_codes_screen.dart which supports
// per-table PNG / Print / Share via the pdf + printing packages.

// ── Bill template editor ────────────────────────────────────────────────
class BillTemplateScreen extends StatefulWidget {
  const BillTemplateScreen({super.key});
  @override State<BillTemplateScreen> createState() => _BillTemplateScreenState();
}

class _BillTemplateScreenState extends State<BillTemplateScreen> {
  final _header = TextEditingController();
  final _footer = TextEditingController();
  final _logoUrl = TextEditingController();
  bool _showTaxBreakdown = true;
  bool _loading = true;
  bool _saving = false;

  @override void initState() { super.initState(); _load(); }

  // Bug fix (B28): dispose controllers when the screen closes so text
  // engine + focus resources don't leak per screen open.
  @override
  void dispose() {
    _header.dispose();
    _footer.dispose();
    _logoUrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final biz = context.read<AuthProvider>().business;
    if (biz == null) { setState(() => _loading = false); return; }
    try {
      final t = await ApiService.instance.getBillTemplate(biz.id);
      _header.text = (t['headerText'] as String?) ?? '';
      _footer.text = (t['footerText'] as String?) ?? '';
      _logoUrl.text = (t['logoUrl'] as String?) ?? '';
      _showTaxBreakdown = (t['showTaxBreakdown'] as bool?) ?? true;
    } catch (e) {
      // Bug fix (B30): log so silent load failures don't surprise users.
      debugPrint('[BillTemplate] load failed: $e');
    }
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _save() async {
    final biz = context.read<AuthProvider>().business!;
    setState(() => _saving = true);
    try {
      await ApiService.instance.saveBillTemplate(biz.id, {
        'headerText': _header.text,
        'footerText': _footer.text,
        'logoUrl': _logoUrl.text,
        'showTaxBreakdown': _showTaxBreakdown,
      });
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Saved')));
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(humanizeError(e))));
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        leading: (ModalRoute.of(context)?.isFirst ?? true) ? const HomeDrawerButton() : null,
        title: const Text('Bill template')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : SafeArea(
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  TextField(controller: _logoUrl, decoration: const InputDecoration(
                    labelText: 'Logo URL', border: OutlineInputBorder())),
                  const SizedBox(height: 12),
                  TextField(controller: _header, maxLines: 3, decoration: const InputDecoration(
                    labelText: 'Header text', border: OutlineInputBorder())),
                  const SizedBox(height: 12),
                  TextField(controller: _footer, maxLines: 3, decoration: const InputDecoration(
                    labelText: 'Footer text', hintText: 'Thank you. Visit again!',
                    border: OutlineInputBorder())),
                  SwitchListTile(
                    title: const Text('Show GST/tax breakdown'),
                    value: _showTaxBreakdown,
                    onChanged: (v) => setState(() => _showTaxBreakdown = v),
                  ),
                  const SizedBox(height: 16),
                  SizedBox(
                    height: 50,
                    child: ElevatedButton(
                      onPressed: _saving ? null : _save,
                      child: _saving
                          ? const SizedBox(height: 20, width: 20,
                              child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                          : const Text('Save', style: TextStyle(fontWeight: FontWeight.w800)),
                    ),
                  ),
                ],
              ),
            ),
      bottomNavigationBar: const HomeBottomNav(),
    );
  }
}

// ── Image upload (general purpose - menu items / logos) ─────────────────
class ImageUploadScreen extends StatefulWidget {
  const ImageUploadScreen({super.key});
  @override State<ImageUploadScreen> createState() => _ImageUploadScreenState();
}

class _ImageUploadScreenState extends State<ImageUploadScreen> {
  XFile? _picked;
  bool _uploading = false;
  String? _uploadedUrl;   // absolute URL after a successful upload

  Future<void> _pick(ImageSource src) async {
    try {
      final f = await ImagePicker().pickImage(source: src, imageQuality: 85);
      if (f != null && mounted) {
        setState(() {
          _picked = f;
          _uploadedUrl = null;
        });
      }
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text('Could not open ${src == ImageSource.camera ? "camera" : "gallery"}: ${humanizeError(e)}'),
        backgroundColor: AppColors.error,
      ));
    }
  }

  /// Backend returns a relative URL like `/uploads/<biz>/<file>.jpg`.
  /// Prefix with the API origin so it's viewable / copy-pasteable.
  String _absoluteUrl(String maybeRelative) {
    if (maybeRelative.startsWith('http://') ||
        maybeRelative.startsWith('https://')) {
      return maybeRelative;
    }
    // ApiService uses baseUrl like `http://localhost:4000/v1`; strip the
    // trailing `/v1` so we hit the static `/uploads/...` mount instead.
    final base = ApiService.instance.dio.options.baseUrl;
    final origin = base.replaceFirst(RegExp(r'/v1/?$'), '');
    final path = maybeRelative.startsWith('/') ? maybeRelative : '/$maybeRelative';
    return '$origin$path';
  }

  Future<void> _upload() async {
    final biz = context.read<AuthProvider>().business;
    if (biz == null || _picked == null) return;
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _uploading = true);
    try {
      final f = MultipartFile.fromBytes(
        await _picked!.readAsBytes(),
        filename: _picked!.name,
      );
      final form = FormData.fromMap({ 'file': f });
      final resp = await ApiService.instance.dio.post(
        '/businesses/${biz.id}/uploads',
        data: form,
      );
      final rawUrl = (resp.data['url'] as String?)
          ?? (resp.data['secureUrl'] as String?);
      if (rawUrl == null) {
        messenger.showSnackBar(const SnackBar(
          content: Text('Upload finished but no URL returned.'),
        ));
        return;
      }
      final absUrl = _absoluteUrl(rawUrl);
      if (!mounted) return;
      // If this screen was pushed as a picker (caller awaits a URL),
      // pop with the URL. Otherwise (opened from the drawer directly)
      // stay put and let the owner copy the URL.
      final canPop = Navigator.of(context).canPop();
      final route = ModalRoute.of(context);
      // Popping only makes sense if the caller is expecting a return
      // value. When opened from drawer via `Navigator.push`, canPop is
      // still true but there's no awaiter — show success + stay put so
      // the owner can copy the link. Simplest heuristic: always stay
      // put; users can use the back arrow to return.
      setState(() {
        _uploadedUrl = absUrl;
        _uploading = false;
      });
      messenger.showSnackBar(SnackBar(
        content: const Text('Uploaded ✓  Link copied.'),
        backgroundColor: AppColors.success,
        action: SnackBarAction(
          label: 'View',
          onPressed: () {}, // no-op; url is on screen
          textColor: Colors.white,
        ),
      ));
      await Clipboard.setData(ClipboardData(text: absUrl));
      // Also return the URL if the parent route wants it.
      if (canPop && route?.isFirst == false) {
        // Small delay so the snackbar is visible before we pop.
        await Future<void>.delayed(const Duration(milliseconds: 400));
        if (mounted) Navigator.pop(context, absUrl);
      }
    } catch (e) {
      if (mounted) setState(() => _uploading = false);
      messenger.showSnackBar(SnackBar(
        content: Text('Upload failed: ${humanizeError(e)}'),
        backgroundColor: AppColors.error,
      ));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        leading: (ModalRoute.of(context)?.isFirst ?? true) ? const HomeDrawerButton() : null,
        title: const Text('Upload image')),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // Preview — uses Image.file for local paths (Android/iOS
              // gallery picker returns a filesystem path, not a URL).
              Center(
                child: Container(
                  width: 220, height: 220,
                  decoration: BoxDecoration(
                    color: AppColors.surface,
                    border: Border.all(color: AppColors.divider),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: _picked == null
                      ? const Center(
                          child: Padding(
                            padding: EdgeInsets.all(16),
                            child: Text(
                              'Pick from camera or gallery to preview.',
                              textAlign: TextAlign.center,
                              style: TextStyle(color: AppColors.textSecondary),
                            ),
                          ),
                        )
                      : ClipRRect(
                          borderRadius: BorderRadius.circular(10),
                          child: Image.file(
                            File(_picked!.path),
                            fit: BoxFit.cover,
                            errorBuilder: (_, __, ___) => const Center(
                              child: Text('Could not preview image',
                                  style: TextStyle(color: AppColors.error)),
                            ),
                          ),
                        ),
                ),
              ),
              if (_uploadedUrl != null) ...[
                const SizedBox(height: 16),
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: AppColors.success.withValues(alpha: 0.08),
                    border: Border.all(color: AppColors.success),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Row(children: [
                        Icon(Icons.check_circle, color: AppColors.success, size: 18),
                        SizedBox(width: 6),
                        Text('Upload succeeded',
                            style: TextStyle(
                                color: AppColors.success,
                                fontWeight: FontWeight.w800)),
                      ]),
                      const SizedBox(height: 6),
                      SelectableText(_uploadedUrl!,
                          style: const TextStyle(fontSize: 12)),
                      const SizedBox(height: 6),
                      Row(
                        children: [
                          TextButton.icon(
                            icon: const Icon(Icons.copy, size: 16),
                            label: const Text('Copy'),
                            onPressed: () async {
                              // Capture messenger before the await so we don't
                              // reach through BuildContext across the async gap.
                              final messenger = ScaffoldMessenger.of(context);
                              await Clipboard.setData(
                                  ClipboardData(text: _uploadedUrl!));
                              messenger.showSnackBar(
                                const SnackBar(content: Text('Copied')),
                              );
                            },
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ],
              const Spacer(),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      icon: const Icon(Icons.camera_alt),
                      label: const Text('Camera'),
                      onPressed: _uploading
                          ? null
                          : () => _pick(ImageSource.camera),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: OutlinedButton.icon(
                      icon: const Icon(Icons.photo_library),
                      label: const Text('Gallery'),
                      onPressed: _uploading
                          ? null
                          : () => _pick(ImageSource.gallery),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              if (_picked != null)
                SizedBox(
                  width: double.infinity, height: 50,
                  child: ElevatedButton(
                    onPressed: _uploading ? null : _upload,
                    child: _uploading
                        ? const SizedBox(
                            width: 22, height: 22,
                            child: CircularProgressIndicator(
                                strokeWidth: 2.4, color: Colors.white),
                          )
                        : const Text('Upload',
                            style: TextStyle(fontWeight: FontWeight.w800)),
                  ),
                ),
            ],
          ),
        ),
      ),
      bottomNavigationBar: const HomeBottomNav(),
    );
  }
}
