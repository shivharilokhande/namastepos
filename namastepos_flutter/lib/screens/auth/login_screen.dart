// NamastePOS — Login screen (Push 4).
//
// Three sign-in paths offered:
//   1. Email + password   (POST /auth/login)
//   2. Google Sign-In     (POST /auth/google with id_token)
//   3. Dev sign-in        (POST /auth/dev-login — only when backend's
//                          FF_DEV_LOGIN=1; hides behind a small text link)
//
// First-time users land on the Register screen via the "Create account"
// link. After any successful auth we route to HomeScreen.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../constants/strings.dart';
import '../../providers/auth_provider.dart';
import 'otp_screen.dart';       // FF-402 restore-orphans
import 'pin_login_screen.dart';
import 'register_screen.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _email = TextEditingController();
  final _password = TextEditingController();

  @override
  void dispose() {
    // H5 (2026-08-23, review): controllers were never disposed.
    _email.dispose();
    _password.dispose();
    super.dispose();
  }
  bool _obscure = true;

  void _afterAuth(bool ok) {
    if (!mounted) return;
    if (ok) {
      // No Navigator.pushAndRemoveUntil here — _RootGate (in app.dart)
      // listens to AuthProvider via Consumer and swaps LoginScreen →
      // HomeScreen automatically when status flips to authenticated.
      // Pushing HomeScreen manually on top of that mounts two HomeScreens
      // at once, both bound to the top-level homeScaffoldKey GlobalKey →
      // "Multiple widgets used the same GlobalKey" → black screen.
      return;
    }
    final err = context.read<AuthProvider>().error;
    if (err != null) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(err)));
    }
  }

  Future<void> _googleSignIn() async {
    final auth = context.read<AuthProvider>();
    final ok = await auth.signInWithGoogle();
    _afterAuth(ok);
  }

  Future<void> _openStaffPinLogin() async {
    // Phone-first staff login (2026-08-26): staff enter their own mobile
    // number and PIN — the owner no longer has to sign in on this device
    // first. The number resolves to the staffer's outlet(s) server-side.
    Navigator.push(context, MaterialPageRoute(
      builder: (_) => const PinLoginScreen(),
    ));
  }

  Future<void> _passwordSignIn() async {
    if (_email.text.trim().isEmpty || _password.text.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Enter email and password')),
      );
      return;
    }
    final auth = context.read<AuthProvider>();
    final ok = await auth.loginWithPassword(_email.text.trim(), _password.text);
    _afterAuth(ok);
  }

  // Dev sign-in helper removed from the customer-facing screen
  // (2026-08-22). Backend endpoint `/auth/dev-login` and
  // `AuthProvider.signInWithEmail` remain available for local
  // scripts / API-driven tests, they're just no longer surfaced.

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthProvider>();

    return Scaffold(
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: 24),
              Center(
                child: Container(
                  width: 80, height: 80,
                  decoration: BoxDecoration(
                    color: AppColors.primary.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(20),
                  ),
                  child: const Icon(Icons.restaurant_menu_rounded,
                      size: 42, color: AppColors.primary),
                ),
              ),
              const SizedBox(height: 20),
              const Center(
                child: Text('Welcome back',
                    style: TextStyle(fontSize: 24, fontWeight: FontWeight.w900)),
              ),
              const Center(
                child: Text(AppStrings.tagline,
                    style: TextStyle(color: AppColors.textSecondary, fontSize: 13)),
              ),
              const SizedBox(height: 28),

              // Quick unlock — shown only when an owner MPIN is set on this
              // device. Jumps to the MPIN lock screen (no full login needed).
              if (auth.mpinEnabled) ...[
                SizedBox(
                  height: 50,
                  child: ElevatedButton.icon(
                    icon: const Icon(Icons.lock_open_outlined, size: 18),
                    label: const Text('Log in with MPIN',
                        style: TextStyle(fontWeight: FontWeight.w900, fontSize: 16)),
                    onPressed: auth.loading
                        ? null
                        : () => context.read<AuthProvider>().lockSession(),
                  ),
                ),
                const SizedBox(height: 16),
                Row(children: const [
                  Expanded(child: Divider()),
                  Padding(
                    padding: EdgeInsets.symmetric(horizontal: 10),
                    child: Text('OR USE ANOTHER ACCOUNT',
                        style: TextStyle(color: AppColors.textHint,
                            fontWeight: FontWeight.w800, fontSize: 11, letterSpacing: 1)),
                  ),
                  Expanded(child: Divider()),
                ]),
                const SizedBox(height: 16),
              ],

              // Email
              TextField(
                controller: _email,
                keyboardType: TextInputType.emailAddress,
                autofillHints: const [AutofillHints.email],
                decoration: InputDecoration(
                  labelText: 'Email',
                  prefixIcon: const Icon(Icons.email_outlined),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(12),
                  ),
                ),
              ),
              const SizedBox(height: 12),
              // Password
              TextField(
                controller: _password,
                obscureText: _obscure,
                autofillHints: const [AutofillHints.password],
                decoration: InputDecoration(
                  labelText: 'Password',
                  prefixIcon: const Icon(Icons.lock_outline),
                  suffixIcon: IconButton(
                    icon: Icon(_obscure ? Icons.visibility_off : Icons.visibility),
                    onPressed: () => setState(() => _obscure = !_obscure),
                  ),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(12),
                  ),
                ),
              ),
              const SizedBox(height: 16),
              SizedBox(
                height: 50,
                child: ElevatedButton(
                  onPressed: auth.loading ? null : _passwordSignIn,
                  child: auth.loading
                      ? const SizedBox(
                          height: 22, width: 22,
                          child: CircularProgressIndicator(
                              strokeWidth: 2.4, color: Colors.white))
                      : const Text('Log in',
                          style: TextStyle(fontWeight: FontWeight.w900, fontSize: 16)),
                ),
              ),
              const SizedBox(height: 14),

              // Or divider
              Row(children: const [
                Expanded(child: Divider()),
                Padding(
                  padding: EdgeInsets.symmetric(horizontal: 10),
                  child: Text('OR',
                      style: TextStyle(
                          color: AppColors.textHint,
                          fontWeight: FontWeight.w800,
                          letterSpacing: 1.4)),
                ),
                Expanded(child: Divider()),
              ]),
              const SizedBox(height: 14),

              // Google
              SizedBox(
                height: 50,
                child: OutlinedButton.icon(
                  icon: const _GoogleLogo(size: 20),
                  label: const Text('Continue with Google',
                      style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
                  onPressed: auth.loading ? null : _googleSignIn,
                  style: OutlinedButton.styleFrom(
                    side: const BorderSide(color: AppColors.divider),
                    foregroundColor: AppColors.textPrimary,
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                  ),
                ),
              ),
              const SizedBox(height: 20),

              // Create account
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Text("Don't have an account? ",
                      style: TextStyle(color: AppColors.textSecondary)),
                  TextButton(
                    onPressed: auth.loading ? null : () => Navigator.push(
                      context,
                      MaterialPageRoute(builder: (_) => const RegisterScreen()),
                    ),
                    child: const Text('Create one',
                        style: TextStyle(fontWeight: FontWeight.w900)),
                  ),
                ],
              ),
              const SizedBox(height: 4),
              // "Sign in as staff" — always visible. If the device has
              // a cached business (owner previously signed in here), tap
              // routes to the staff picker. If not, show an explanatory
              // toast — the owner has to sign in once first so we know
              // which business's staff to show.
              Center(
                child: TextButton.icon(
                  onPressed: auth.loading ? null : _openStaffPinLogin,
                  icon: const Icon(Icons.pin_outlined, size: 16),
                  label: const Text('Sign in as staff (PIN)',
                      style: TextStyle(fontWeight: FontWeight.w700)),
                ),
              ),
              // FF-402 restore-orphans: OTP-login is an alternative for
              // users without a Google account or password. Backend's
              // /auth/otp/request + /auth/otp/verify handle it.
              Center(
                child: TextButton.icon(
                  onPressed: auth.loading ? null : () {
                    Navigator.of(context).push(MaterialPageRoute(
                      builder: (_) => const OtpScreen(),
                    ));
                  },
                  icon: const Icon(Icons.sms_outlined, size: 16),
                  label: const Text('Sign in with phone (OTP)',
                      style: TextStyle(fontWeight: FontWeight.w700)),
                ),
              ),
              // Owner asked to remove the Dev sign-in link from the
              // login screen (2026-08-22). The backend endpoint
              // `/auth/dev-login` is still available behind
              // FF_DEV_LOGIN=1 for local testing via api_service, but
              // the customer-facing screen no longer exposes it.
            ],
          ),
        ),
      ),
    );
  }
}

class _GoogleLogo extends StatelessWidget {
  final double size;
  const _GoogleLogo({this.size = 22});
  @override
  Widget build(BuildContext context) =>
      SizedBox(width: size, height: size, child: CustomPaint(painter: _GooglePainter()));
}

class _GooglePainter extends CustomPainter {
  static const _blue = Color(0xFF4285F4);
  static const _green = Color(0xFF34A853);
  static const _yellow = Color(0xFFFBBC04);
  static const _red = Color(0xFFEA4335);
  @override
  void paint(Canvas canvas, Size size) {
    final r = size.width / 2;
    final c = Offset(r, r);
    final stroke = size.width * 0.18;
    final rect = Rect.fromCircle(center: c, radius: r - stroke / 2);
    final p = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..strokeCap = StrokeCap.butt;
    p.color = _blue; canvas.drawArc(rect, -0.6, 1.6, false, p);
    p.color = _green; canvas.drawArc(rect, 1.0, 1.2, false, p);
    p.color = _yellow; canvas.drawArc(rect, 2.2, 1.4, false, p);
    p.color = _red; canvas.drawArc(rect, 3.6, 1.8, false, p);
    final bar = Paint()..color = _blue;
    canvas.drawRect(Rect.fromLTWH(
        c.dx, c.dy - size.height * 0.06, size.width * 0.45, size.height * 0.12), bar);
  }
  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
