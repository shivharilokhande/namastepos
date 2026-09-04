// NamastePOS — Registration screen (Push 4).
//
// Collects email + password + optional name + optional business-name and
// hits POST /auth/register. The backend bcrypt-hashes the password, creates
// the user + a fresh Starter-tier business + a 30-day trial subscription,
// then returns the same session payload as Google login.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../providers/auth_provider.dart';
import '../../services/analytics_service.dart';
import '../../services/api_service.dart';
import '../../widgets/google_logo.dart';

// DPDP — the policy version we record alongside the consent event.
// Bump this string every time the published policy changes so the
// audit trail can prove what the user actually saw.
const String _kPrivacyPolicyVersion   = 'privacy-2026-05-26';
const String _kTermsOfServiceVersion  = 'tos-2026-05-26';

class RegisterScreen extends StatefulWidget {
  const RegisterScreen({super.key});

  @override
  State<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends State<RegisterScreen> {
  final _name = TextEditingController();
  final _businessName = TextEditingController();
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _confirm = TextEditingController();

  @override
  void dispose() {
    // H5 (2026-08-23, review): controllers were never disposed.
    _name.dispose();
    _businessName.dispose();
    _email.dispose();
    _password.dispose();
    _confirm.dispose();
    super.dispose();
  }
  bool _obscure = true;
  // DPDP requires consent to be **granular** — splitting the mandatory
  // policy-acceptance from the optional marketing opt-ins. The first
  // is required to register; the rest are pre-unchecked (positive
  // affirmation only counts as consent).
  bool _agreePolicy   = false;
  bool _marketingEmail    = false;
  bool _marketingWhatsapp = false;

  Future<void> _submit() async {
    if (_email.text.trim().isEmpty || _password.text.isEmpty) {
      _snack('Enter email and password');
      return;
    }
    if (_password.text.length < 8) {
      _snack('Password must be at least 8 characters');
      return;
    }
    if (_password.text != _confirm.text) {
      _snack('Passwords don\'t match');
      return;
    }
    if (!_agreePolicy) {
      _snack('Please accept the Privacy Policy and Terms of Service');
      return;
    }

    final auth = context.read<AuthProvider>();
    final ok = await auth.registerWithPassword(
      email: _email.text.trim(),
      password: _password.text,
      name: _name.text.trim().isEmpty ? null : _name.text.trim(),
      businessName: _businessName.text.trim().isEmpty ? null : _businessName.text.trim(),
    );
    if (!mounted) return;
    if (!ok && auth.error != null) {
      _snack(auth.error!);
      return;
    }

    // Activation funnel — cohort anchor. Fired only on the REGISTER screen;
    // the login screen's Google button is a sign-IN on an existing account.
    // No referral capture exists in the app (no deep-link ?ref=), so the
    // code is empty here and only the web signup carries one.
    Activation.signup(
      method: 'email',
      hasBusinessName: _businessName.text.trim().isNotEmpty,
    );

    // DPDP — record the consents the user just gave. Best-effort: if
    // these calls fail (network blip) the user is still registered, and
    // the next /me/consents check will reveal the gap so the app can
    // re-prompt.
    await _recordConsents();

    // Success path: _RootGate sees auth.status flip and swaps to HomeScreen.
    // Don't pushAndRemoveUntil here — see the matching comment in
    // LoginScreen._afterAuth for the GlobalKey duplicate-mount story.
  }

  // Google sign-up (2026-08-25): the backend finds-or-creates the account
  // from the Google token, so this is a full registration path. DPDP
  // consent stays mandatory — the checkbox must be ticked first.
  Future<void> _googleSignUp() async {
    if (!_agreePolicy) {
      _snack('Please accept the Privacy Policy and Terms of Service first');
      return;
    }
    final auth = context.read<AuthProvider>();
    final ok = await auth.signInWithGoogle();
    if (!mounted) return;
    if (!ok) {
      if (auth.error != null) _snack(auth.error!);
      return;
    }
    // Activation funnel — see the note in _submit. Google here is a
    // find-or-create, so `business_created.is_new` (fired from
    // AuthProvider._postLogin) is what distinguishes a genuinely new account.
    Activation.signup(
      method: 'google',
      hasBusinessName: _businessName.text.trim().isNotEmpty,
    );
    await _recordConsents();
    // _RootGate sees auth.status flip and swaps to HomeScreen.
  }

  // DPDP — shared by password and Google registration paths.
  Future<void> _recordConsents() async {
    final api = ApiService.instance;
    try {
      await api.recordConsent(
        consentKey:    'privacy_policy',
        granted:       true,
        policyVersion: _kPrivacyPolicyVersion,
        source:        'mobile_app',
        context:       {'flow': 'registration'},
      );
      await api.recordConsent(
        consentKey:    'terms_of_service',
        granted:       true,
        policyVersion: _kTermsOfServiceVersion,
        source:        'mobile_app',
        context:       {'flow': 'registration'},
      );
      if (_marketingEmail) {
        await api.recordConsent(
          consentKey: 'marketing_email',
          granted:    true,
          source:     'mobile_app',
          context:    {'flow': 'registration'},
        );
      }
      if (_marketingWhatsapp) {
        await api.recordConsent(
          consentKey: 'marketing_whatsapp',
          granted:    true,
          source:     'mobile_app',
          context:    {'flow': 'registration'},
        );
      }
    } catch (_) {
      // Non-fatal — the next /me/consents check will reveal any gap.
    }
  }

  void _snack(String msg) =>
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthProvider>();
    return Scaffold(
      appBar: AppBar(title: const Text('Create your account')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text("It's free — no credit card needed",
                  style: TextStyle(color: AppColors.textSecondary)),
              const SizedBox(height: 4),
              const Text("You'll start on the Starter plan and can upgrade anytime.",
                  style: TextStyle(color: AppColors.textHint, fontSize: 12)),
              const SizedBox(height: 24),

              TextField(
                controller: _name,
                textCapitalization: TextCapitalization.words,
                decoration: const InputDecoration(
                    labelText: 'Your name (optional)',
                    border: OutlineInputBorder()),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _businessName,
                textCapitalization: TextCapitalization.words,
                decoration: const InputDecoration(
                    labelText: 'Business name (e.g. Shiv\'s Cafe)',
                    border: OutlineInputBorder()),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _email,
                keyboardType: TextInputType.emailAddress,
                autofillHints: const [AutofillHints.email],
                decoration: const InputDecoration(
                    labelText: 'Email *',
                    border: OutlineInputBorder()),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _password,
                obscureText: _obscure,
                autofillHints: const [AutofillHints.newPassword],
                decoration: InputDecoration(
                  labelText: 'Password * (8+ characters)',
                  border: const OutlineInputBorder(),
                  suffixIcon: IconButton(
                    icon: Icon(_obscure ? Icons.visibility_off : Icons.visibility),
                    onPressed: () => setState(() => _obscure = !_obscure),
                  ),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _confirm,
                obscureText: _obscure,
                decoration: const InputDecoration(
                    labelText: 'Confirm password *',
                    border: OutlineInputBorder()),
              ),
              const SizedBox(height: 16),
              // DPDP: granular consent. The first checkbox is required
              // (must positively accept the policy + ToS); the next two
              // are optional and default to OFF (DPDP — silence is not
              // consent).
              CheckboxListTile(
                value: _agreePolicy,
                onChanged: (v) => setState(() => _agreePolicy = v ?? false),
                title: const Text(
                    'I have read & accept the Privacy Policy and Terms of Service *',
                    style: TextStyle(fontSize: 12)),
                controlAffinity: ListTileControlAffinity.leading,
                contentPadding: EdgeInsets.zero,
                dense: true,
              ),
              CheckboxListTile(
                value: _marketingEmail,
                onChanged: (v) => setState(() => _marketingEmail = v ?? false),
                title: const Text(
                    'Send me product updates & tips by email (optional)',
                    style: TextStyle(fontSize: 12)),
                controlAffinity: ListTileControlAffinity.leading,
                contentPadding: EdgeInsets.zero,
                dense: true,
              ),
              CheckboxListTile(
                value: _marketingWhatsapp,
                onChanged: (v) => setState(() => _marketingWhatsapp = v ?? false),
                title: const Text(
                    'Send me product updates on WhatsApp (optional)',
                    style: TextStyle(fontSize: 12)),
                controlAffinity: ListTileControlAffinity.leading,
                contentPadding: EdgeInsets.zero,
                dense: true,
              ),
              const SizedBox(height: 4),
              const Text(
                'You can withdraw any consent at any time from '
                'Settings → Privacy. Withdrawal is as easy as opting in.',
                style: TextStyle(color: AppColors.textHint, fontSize: 11),
              ),
              const SizedBox(height: 8),
              SizedBox(
                height: 50,
                child: ElevatedButton(
                  onPressed: auth.loading ? null : _submit,
                  child: auth.loading
                      ? const SizedBox(
                          height: 22, width: 22,
                          child: CircularProgressIndicator(
                              strokeWidth: 2.4, color: Colors.white))
                      : const Text('Create account',
                          style: TextStyle(
                              fontWeight: FontWeight.w900, fontSize: 16)),
                ),
              ),
              const SizedBox(height: 16),
              Row(children: [
                const Expanded(child: Divider()),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  child: Text('OR',
                      style: TextStyle(
                          color: AppColors.textHint, fontSize: 12)),
                ),
                const Expanded(child: Divider()),
              ]),
              const SizedBox(height: 16),
              SizedBox(
                height: 50,
                child: OutlinedButton.icon(
                  icon: const GoogleLogo(size: 20),
                  label: const Text('Sign up with Google',
                      style: TextStyle(fontWeight: FontWeight.w700)),
                  onPressed: auth.loading ? null : _googleSignUp,
                ),
              ),
              const SizedBox(height: 12),
              Center(
                child: TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('Already have an account? Log in'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
