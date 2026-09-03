// NamastePOS — Privacy & data control center (DPDP s.11–13).
//
// Mobile equivalent of the dashboard's /privacy page. Lets the
// signed-in owner / staff:
//   - View current consents (privacy + terms always granted; marketing
//     toggles are opt-in)
//   - Toggle marketing consents on/off (writes an append-only event)
//   - Download a JSON export of their data
//   - File a correction request
//   - File a grievance with the Grievance Officer
//   - Delete their account (soft-erase)

import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:provider/provider.dart';
import 'package:share_plus/share_plus.dart';

import '../../constants/colors.dart';
import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import 'privacy_policy_screen.dart';

class PrivacyScreen extends StatefulWidget {
  const PrivacyScreen({super.key});

  @override
  State<PrivacyScreen> createState() => _PrivacyScreenState();
}

class _PrivacyScreenState extends State<PrivacyScreen> {
  static const _toggleable = <Map<String, String>>[
    {'key': 'marketing_email',    'label': 'Marketing emails',
     'help': 'Product updates, tips and offers in your inbox.'},
    {'key': 'marketing_whatsapp', 'label': 'Marketing on WhatsApp',
     'help': 'Same content, but on WhatsApp Business.'},
    {'key': 'marketing_sms',      'label': 'Marketing SMS',
     'help': 'Promotional SMS (rare — only for major launches).'},
  ];

  bool _loading = true;
  Map<String, bool> _state = {};
  Map<String, dynamic>? _officer;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final api = ApiService.instance;
      final consents = await api.currentConsents();
      final state = <String, bool>{};
      for (final c in consents) {
        if (c is Map && c['consentKey'] is String) {
          state[c['consentKey'] as String] = c['granted'] == true;
        }
      }
      final officer = await api.grievanceOfficer().catchError((_) => <String, dynamic>{});
      if (!mounted) return;
      setState(() {
        _state = state;
        _officer = officer;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _loading = false);
      _snack('Could not load privacy state: $e');
    }
  }

  Future<void> _toggle(String key, bool granted) async {
    try {
      await ApiService.instance.recordConsent(
        consentKey: key,
        granted:    granted,
        source:     'mobile_app',
        context:    {'surface': 'privacy_screen'},
      );
      setState(() => _state[key] = granted);
      _snack(granted ? 'Consent recorded' : 'Consent withdrawn');
    } catch (e) {
      _snack('Could not update: $e');
    }
  }

  Future<void> _export() async {
    try {
      final data = await ApiService.instance.exportMyData();
      final dir = await getTemporaryDirectory();
      final f = File('${dir.path}/namastepos-data-export.json');
      await f.writeAsString(const JsonEncoder.withIndent('  ').convert(data));
      await SharePlus.instance.share(ShareParams(
          files: [XFile(f.path)],
          subject: 'NamastePOS data export'));
      _snack('Export ready');
    } catch (e) {
      _snack('Export failed: $e');
    }
  }

  Future<void> _erase() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete account?'),
        content: const Text(
          'We will anonymise your direct identifiers immediately. '
          'Records the law requires us to keep (e.g. tax invoices) '
          'will be retained for the required period and then deleted. '
          'This cannot be undone.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: TextButton.styleFrom(foregroundColor: AppColors.error),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      await ApiService.instance.eraseMyAccount();
      if (!mounted) return;
      // NP-104: the account is erased server-side — a plain logout() would
      // keep the local DB (and with an MPIN set, merely LOCK back into the
      // dead session). Full sign-out wipes SQLite + outbox + MPIN.
      await context.read<AuthProvider>().logoutFull();
      if (!mounted) return;
      Navigator.of(context).popUntil((r) => r.isFirst);
      _snack('Account erased');
    } catch (e) {
      _snack('Could not delete: $e');
    }
  }

  Future<void> _fileGrievance() async {
    final result = await showDialog<Map<String, String>>(
      context: context,
      builder: (_) => const _GrievanceDialog(),
    );
    if (result == null) return;
    try {
      await ApiService.instance.fileGrievance(
        subject:  result['subject']!,
        body:     result['body']!,
        category: result['category'] ?? 'privacy',
      );
      _snack('Grievance filed. You will hear back from the Grievance Officer.');
    } catch (e) {
      _snack('Could not file: $e');
    }
  }

  Future<void> _fileCorrection() async {
    final result = await showDialog<Map<String, String>>(
      context: context,
      builder: (_) => const _CorrectionDialog(),
    );
    if (result == null) return;
    try {
      await ApiService.instance.fileDataSubjectRequest(
        requestType: 'correction',
        details: {
          'field':    result['field'],
          'newValue': result['newValue'],
          'reason':   result['reason'],
        },
      );
      _snack('Correction request filed. We will review within 30 days.');
    } catch (e) {
      _snack('Could not file: $e');
    }
  }

  void _snack(String msg) =>
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Privacy & data')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.symmetric(vertical: 12),
              children: [
                _section('Communication preferences'),
                ..._toggleable.map((c) => SwitchListTile(
                      value: _state[c['key']] ?? false,
                      onChanged: (v) => _toggle(c['key']!, v),
                      title: Text(c['label']!,
                          style: const TextStyle(fontWeight: FontWeight.w600)),
                      subtitle: Text(c['help']!,
                          style: const TextStyle(fontSize: 12)),
                      activeThumbColor: AppColors.primary,
                    )),

                _section('Your data (DPDP rights)'),
                _action(Icons.download_rounded, 'Download my data', _export),
                _action(Icons.edit_note_rounded, 'Request a correction', _fileCorrection),
                _action(Icons.delete_forever_rounded, 'Delete my account', _erase,
                    color: AppColors.error),

                _section('Help & legal'),
                _action(Icons.policy_outlined, 'Privacy Policy', () {
                  Navigator.push(context, MaterialPageRoute(
                      builder: (_) => const PrivacyPolicyScreen(kind: 'privacy')));
                }),
                _action(Icons.gavel_outlined, 'Terms of Service', () {
                  Navigator.push(context, MaterialPageRoute(
                      builder: (_) => const PrivacyPolicyScreen(kind: 'terms')));
                }),
                _action(Icons.support_agent_rounded, 'File a grievance', _fileGrievance),

                if (_officer != null && _officer!['grievanceOfficer'] is Map)
                  _officerCard(_officer!['grievanceOfficer'] as Map),

                const SizedBox(height: 30),
              ],
            ),
    );
  }

  Widget _section(String title) => Padding(
        padding: const EdgeInsets.fromLTRB(20, 18, 20, 6),
        child: Text(title,
            style: const TextStyle(
                color: AppColors.textSecondary,
                fontWeight: FontWeight.w700,
                fontSize: 12,
                letterSpacing: 0.5)),
      );

  Widget _action(IconData icon, String label, VoidCallback onTap,
          {Color? color}) =>
      ListTile(
        leading: Icon(icon, color: color ?? AppColors.primary),
        title: Text(label,
            style: TextStyle(
                fontWeight: FontWeight.w600,
                color: color ?? AppColors.textPrimary)),
        trailing: const Icon(Icons.chevron_right_rounded,
            color: AppColors.textHint),
        onTap: onTap,
      );

  Widget _officerCard(Map o) {
    final name = (o['name'] ?? '').toString();
    if (name.isEmpty) {
      return Container(
        margin: const EdgeInsets.fromLTRB(20, 8, 20, 8),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: AppColors.background,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: AppColors.border),
        ),
        child: const Text(
          'Grievance Officer contact will be published here once finalised.',
          style: TextStyle(fontSize: 12, color: AppColors.textSecondary,
              fontStyle: FontStyle.italic),
        ),
      );
    }
    return Container(
      margin: const EdgeInsets.fromLTRB(20, 8, 20, 8),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.background,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('Grievance Officer',
              style: TextStyle(fontWeight: FontWeight.w700)),
          const SizedBox(height: 4),
          Text(name, style: const TextStyle(fontSize: 13)),
          if ((o['email'] ?? '').toString().isNotEmpty)
            Text(o['email'].toString(),
                style: const TextStyle(fontSize: 12,
                    color: AppColors.textSecondary)),
          if ((o['phone'] ?? '').toString().isNotEmpty)
            Text(o['phone'].toString(),
                style: const TextStyle(fontSize: 12,
                    color: AppColors.textSecondary)),
        ],
      ),
    );
  }
}

// ── Dialogs ─────────────────────────────────────────────────────────────

class _GrievanceDialog extends StatefulWidget {
  const _GrievanceDialog();
  @override
  State<_GrievanceDialog> createState() => _GrievanceDialogState();
}

class _GrievanceDialogState extends State<_GrievanceDialog> {
  final _subject = TextEditingController();
  final _body = TextEditingController();
  String _category = 'privacy';

  // Bug fix (B28): controllers must be disposed when the dialog closes,
  // otherwise text engine + focus resources leak on every open.
  @override
  void dispose() {
    _subject.dispose();
    _body.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('File a grievance'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            DropdownButtonFormField<String>(
              value: _category,
              decoration: const InputDecoration(labelText: 'Category'),
              items: const [
                DropdownMenuItem(value: 'privacy',     child: Text('Privacy')),
                DropdownMenuItem(value: 'data_misuse', child: Text('Data misuse')),
                DropdownMenuItem(value: 'consent',     child: Text('Consent')),
                DropdownMenuItem(value: 'security',    child: Text('Security')),
                DropdownMenuItem(value: 'billing',     child: Text('Billing')),
                DropdownMenuItem(value: 'other',       child: Text('Other')),
              ],
              onChanged: (v) => setState(() => _category = v ?? 'privacy'),
            ),
            const SizedBox(height: 8),
            TextField(controller: _subject,
              decoration: const InputDecoration(labelText: 'Subject')),
            const SizedBox(height: 8),
            TextField(controller: _body,
              decoration: const InputDecoration(labelText: 'Details'),
              maxLines: 4),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        ElevatedButton(
          onPressed: () {
            if (_subject.text.trim().isEmpty || _body.text.trim().isEmpty) return;
            Navigator.pop(context, {
              'subject':  _subject.text.trim(),
              'body':     _body.text.trim(),
              'category': _category,
            });
          },
          child: const Text('File'),
        ),
      ],
    );
  }
}

class _CorrectionDialog extends StatefulWidget {
  const _CorrectionDialog();
  @override
  State<_CorrectionDialog> createState() => _CorrectionDialogState();
}

class _CorrectionDialogState extends State<_CorrectionDialog> {
  final _field = TextEditingController();
  final _newValue = TextEditingController();
  final _reason = TextEditingController();

  // Bug fix (B28): dispose controllers when the dialog closes.
  @override
  void dispose() {
    _field.dispose();
    _newValue.dispose();
    _reason.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Request a correction'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(controller: _field,
                decoration: const InputDecoration(labelText: 'Field to correct')),
            const SizedBox(height: 8),
            TextField(controller: _newValue,
                decoration: const InputDecoration(labelText: 'Correct value')),
            const SizedBox(height: 8),
            TextField(controller: _reason,
                decoration: const InputDecoration(labelText: 'Reason (optional)'),
                maxLines: 2),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        ElevatedButton(
          onPressed: () {
            if (_field.text.trim().isEmpty || _newValue.text.trim().isEmpty) return;
            Navigator.pop(context, {
              'field':    _field.text.trim(),
              'newValue': _newValue.text.trim(),
              'reason':   _reason.text.trim(),
            });
          },
          child: const Text('Submit'),
        ),
      ],
    );
  }
}
