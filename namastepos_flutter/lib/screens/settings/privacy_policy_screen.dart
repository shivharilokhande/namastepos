// NamastePOS — Privacy Policy / Terms of Service viewer.
//
// Mobile equivalent of the dashboard's LegalPage. Shows the same DRAFT
// scaffold and clearly marks it as awaiting lawyer review. Bumps the
// version string in the AppBar so the user always knows which revision
// they're looking at.

import 'package:flutter/material.dart';

import '../../constants/colors.dart';
import '../../services/api_service.dart';

class PrivacyPolicyScreen extends StatefulWidget {
  /// 'privacy' or 'terms'
  final String kind;
  const PrivacyPolicyScreen({super.key, required this.kind});

  @override
  State<PrivacyPolicyScreen> createState() => _PrivacyPolicyScreenState();
}

class _PrivacyPolicyScreenState extends State<PrivacyPolicyScreen> {
  Map<String, dynamic>? _officer;

  @override
  void initState() {
    super.initState();
    ApiService.instance
        .grievanceOfficer()
        .then((d) {
          if (!mounted) return;
          setState(() => _officer = d);
        })
        .catchError((_) => null);
  }

  String get _title => widget.kind == 'privacy' ? 'Privacy Policy' : 'Terms of Service';
  String get _version =>
      widget.kind == 'privacy' ? 'privacy-2026-05-26' : 'tos-2026-05-26';

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(_title)),
      body: ListView(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        children: [
          // DRAFT banner — must remain visible until the lawyer-reviewed
          // text replaces the placeholder content.
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: AppColors.warning.withValues(alpha: 0.12),
              border: Border.all(color: AppColors.warning, width: 2),
              borderRadius: BorderRadius.circular(10),
            ),
            child: const Text(
              'DRAFT — under legal review.\n'
              'This text is a placeholder for the lawyer-reviewed policy. '
              'Treat it as informational until the published version replaces it. '
              'Open Settings → Privacy & data to exercise your rights now.',
              style: TextStyle(fontSize: 12),
            ),
          ),
          const SizedBox(height: 16),
          Text(_title,
              style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w900)),
          Text('Version $_version',
              style: const TextStyle(fontSize: 11, color: AppColors.textHint)),
          const SizedBox(height: 16),
          if (widget.kind == 'privacy')
            ..._privacyBody(_officer)
          else
            ..._termsBody(),
          const SizedBox(height: 24),
          Divider(color: AppColors.divider),
          const SizedBox(height: 8),
          Text(
            'Questions? File a grievance from Settings → Privacy & data, '
            'or email the Grievance Officer at '
            '${_officer?['grievanceOfficer']?['email'] ?? 'email pending'}.',
            style: const TextStyle(fontSize: 11, color: AppColors.textSecondary),
          ),
          const SizedBox(height: 30),
        ],
      ),
    );
  }
}

List<Widget> _privacyBody(Map<String, dynamic>? officer) {
  final entityName    = officer?['legalEntity']?['name']    ?? '[Legal entity — pending incorporation]';
  final entityAddress = officer?['legalEntity']?['address'] ?? '[address — pending]';
  final officerName   = officer?['grievanceOfficer']?['name']  ?? '';
  final officerEmail  = officer?['grievanceOfficer']?['email'] ?? '';
  final officerPhone  = officer?['grievanceOfficer']?['phone'] ?? '';
  return [
    _h('1. Who we are'),
    _p('NamastePOS is a multi-tenant SaaS POS for restaurants, cafés and street vendors in India. '
        'References to "we", "us", or "NamastePOS" mean $entityName. '
        'Our registered address is $entityAddress.'),
    _h('2. Data we collect'),
    _li('Account: name, email, phone, password (hashed), Google sub.'),
    _li('Business: name, GSTIN, address, bank/UPI used for payouts.'),
    _li('Operational: orders, invoices, expenses, menu, staff PINs.'),
    _li('Customer: phone, name (optional), order history, loyalty points.'),
    _li('Diagnostics: IP, device, error logs, audit events.'),
    _h('3. Purposes & legal basis'),
    _p('Personal data is processed for: providing the service (contract), complying with GST and income-tax obligations '
        '(legal obligation), customer support (legitimate interest), and marketing (only with your explicit, separate consent).'),
    _h('4. Sharing'),
    _p('We share data with sub-processors required to run the service: hosting (India region), payment processor (Razorpay), '
        'e-invoice IRP (NIC), email/WhatsApp delivery (Twilio), and error monitoring (Sentry). '
        'We do not sell personal data. Customer (diner) data stays with the merchant — we only act as a data processor for it.'),
    _h('5. Retention'),
    _p('Account data is kept while the account is active. After erasure, we retain only what the law requires '
        '— tax invoices for eight years, transaction records as required by RBI rules. We delete the rest within 30 days.'),
    _h('6. Your rights (DPDP s.11–13)'),
    _p('You can access, correct, erase, withdraw consent, and export your data at any time from Settings → Privacy & data. '
        'Withdrawal is as easy as opting in.'),
    _h('7. Grievance Officer'),
    if (officerName.toString().isNotEmpty)
      _p('$officerName${officerEmail.toString().isNotEmpty ? ' · $officerEmail' : ''}'
          '${officerPhone.toString().isNotEmpty ? ' · $officerPhone' : ''}')
    else
      _p('Grievance Officer contact will be published here once finalised.'),
    _h('8. Children'),
    _p('The service is not intended for users under 18. We do not knowingly collect data from children.'),
    _h('9. Changes'),
    _p('We will notify you by email and in-app when this policy changes. The version number above changes with each revision.'),
  ];
}

List<Widget> _termsBody() => [
      _h('1. Acceptance'),
      _p('By creating an account, you agree to these Terms and the Privacy Policy. If you don\'t agree, don\'t use the service.'),
      _h('2. The service'),
      _p('NamastePOS gives Indian F&B businesses a multi-tenant POS, billing, inventory, and customer-engagement platform. '
          'We may add, remove, or change features over time.'),
      _h('3. Your data'),
      _p('You retain ownership of all data you enter. We process it strictly to operate the service on your behalf. '
          'See the Privacy Policy for full detail.'),
      _h('4. Acceptable use'),
      _p('No unlawful, abusive, or fraudulent activity. No reverse engineering. '
          'No interference with the service for other tenants.'),
      _h('5. Payments & refunds'),
      _p('Paid plans renew monthly until cancelled. You can cancel anytime via Plans & Billing. '
          'Pro-rata refunds are at our discretion.'),
      _h('6. Liability'),
      _p('We provide the service "as is". Our liability is capped at the amount you paid in the past 12 months. '
          'We are not liable for lost profits or indirect damages.'),
      _h('7. Governing law'),
      _p('Indian law. Disputes go to the courts in the registered office\'s jurisdiction.'),
    ];

Widget _h(String text) => Padding(
      padding: const EdgeInsets.fromLTRB(0, 14, 0, 6),
      child: Text(text,
          style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 14)),
    );
Widget _p(String text) => Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Text(text, style: const TextStyle(fontSize: 13, height: 1.45)),
    );
Widget _li(String text) => Padding(
      padding: const EdgeInsets.only(left: 12, bottom: 4),
      child: Text('• $text', style: const TextStyle(fontSize: 13, height: 1.45)),
    );
