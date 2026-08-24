// NamastePOS — Phone OTP sign-in screen.
//
// FF-402 restore-orphans pass 2: this screen is wired into LoginScreen so
// owners without Google can eventually sign in by phone. The backend phone-
// OTP endpoints (`/auth/otp/request` + `/auth/otp/verify`) are still on the
// roadmap (see FF-402 pending list), and AuthProvider does not yet expose
// `requestOtp` / `verifyOtp` / `pendingPhone`. Rather than pretend, this
// screen presents a clear preview UI and points people at Google or email
// sign-in — which do work today. When the backend routes land, swap
// `_submit()` for the real AuthProvider calls; the phone + 6-digit UI is
// already here so no UI rework is needed at that point.
//
// Kept dependencies to plain Flutter (no `pin_code_fields`) so the app
// keeps building even if that transitive dep hasn't been fetched yet.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../providers/auth_provider.dart';
import '../../widgets/primary_button.dart';

class OtpScreen extends StatefulWidget {
  const OtpScreen({super.key});

  @override
  State<OtpScreen> createState() => _OtpScreenState();
}

class _OtpScreenState extends State<OtpScreen> {
  final _phone = TextEditingController();
  final _code = TextEditingController();
  bool _codeSent = false;

  @override
  void dispose() {
    _phone.dispose();
    _code.dispose();
    super.dispose();
  }

  void _requestCode() {
    if (_phone.text.trim().length < 10) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Enter a 10-digit phone number')),
      );
      return;
    }
    setState(() => _codeSent = true);
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text(
        'Phone OTP is coming soon. For now, please use Google or email sign-in.',
      )),
    );
  }

  void _submit() {
    // When backend `/auth/otp/verify` and AuthProvider.verifyOtp land,
    // replace this stub with:
    //   final ok = await context.read<AuthProvider>().verifyOtp(_code.text);
    //   if (ok && mounted) Navigator.pop(context);
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text(
        'Phone-OTP sign-in is not enabled yet. Use Google or email sign-in.',
      )),
    );
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthProvider>();

    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => Navigator.pop(context),
        ),
        title: const Text('Sign in with phone'),
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: 8),
              const Text(
                'Verify with your phone',
                style: TextStyle(
                  fontSize: 24, fontWeight: FontWeight.w800,
                  color: AppColors.textPrimary,
                ),
              ),
              const SizedBox(height: 6),
              const Text(
                'Enter your mobile number and we\'ll send a 6-digit code.',
                style: TextStyle(
                  color: AppColors.textSecondary, fontSize: 14,
                ),
              ),
              const SizedBox(height: 24),
              TextField(
                controller: _phone,
                keyboardType: TextInputType.phone,
                inputFormatters: [
                  FilteringTextInputFormatter.digitsOnly,
                  LengthLimitingTextInputFormatter(10),
                ],
                decoration: InputDecoration(
                  labelText: 'Phone number',
                  prefixIcon: const Icon(Icons.phone_outlined),
                  prefixText: '+91 ',
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(12),
                  ),
                ),
              ),
              const SizedBox(height: 12),
              if (!_codeSent)
                SizedBox(
                  height: 50,
                  child: OutlinedButton.icon(
                    icon: const Icon(Icons.sms_outlined, size: 18),
                    label: const Text('Send code',
                        style: TextStyle(fontWeight: FontWeight.w700)),
                    onPressed: auth.loading ? null : _requestCode,
                    style: OutlinedButton.styleFrom(
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                      ),
                    ),
                  ),
                ),
              if (_codeSent) ...[
                const SizedBox(height: 8),
                TextField(
                  controller: _code,
                  keyboardType: TextInputType.number,
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    fontSize: 22,
                    fontWeight: FontWeight.w700,
                    letterSpacing: 8,
                  ),
                  inputFormatters: [
                    FilteringTextInputFormatter.digitsOnly,
                    LengthLimitingTextInputFormatter(6),
                  ],
                  decoration: InputDecoration(
                    labelText: '6-digit code',
                    counterText: '',
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(12),
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                PrimaryButton(
                  label: 'Verify',
                  loading: auth.loading,
                  onPressed: _code.text.length == 6 ? _submit : null,
                ),
                const SizedBox(height: 8),
                Center(
                  child: TextButton(
                    onPressed: () => setState(() => _codeSent = false),
                    child: const Text('Change phone number'),
                  ),
                ),
              ],
              const SizedBox(height: 24),
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: AppColors.info.withValues(alpha: 0.08),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: const Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(Icons.info_outline, size: 18, color: AppColors.info),
                    SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        'Phone-OTP sign-in is being finalised. '
                        'For now, please use Google or email sign-in from '
                        'the previous screen.',
                        style: TextStyle(
                          fontSize: 12,
                          color: AppColors.info,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
