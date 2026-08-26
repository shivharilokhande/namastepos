// NamastePOS - Root app widget with routing & theming

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'constants/theme.dart';
import 'providers/auth_provider.dart';
import 'screens/auth/login_screen.dart';
import 'screens/auth/mpin_lock_screen.dart';
import 'screens/auth/onboarding_screen.dart';
import 'screens/home/home_screen.dart';
import 'screens/onboarding/setup_wizard_screen.dart';
import 'screens/splash_screen.dart';
import 'services/api_service.dart';
import 'widgets/connectivity_banner.dart';

class NamastePOSApp extends StatelessWidget {
  const NamastePOSApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'NamastePOS',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.lightTheme,
      darkTheme: AppTheme.darkTheme,
      themeMode: ThemeMode.light,
      home: const _RootGate(),
      routes: {
        '/login': (_) => const LoginScreen(),
        '/onboarding': (_) => const OnboardingScreen(),
        '/home': (_) => const HomeScreen(),
      },
      // FF-219: wrap every screen in the connectivity banner. Using
      // `builder` (not the child of `home`) ensures the banner shows on
      // pushed routes too (POS confirm, KDS, reports…).
      builder: (context, child) => ConnectivityBanner(child: child ?? const SizedBox.shrink()),
    );
  }
}

/// Decides which screen to show on app launch based on auth state.
///
/// The trial-expired gate lives inside HomeScreen (where SubscriptionProvider
/// is already loaded), not here — keeping _RootGate small avoids surprising
/// builds during sign-in transitions.
class _RootGate extends StatelessWidget {
  const _RootGate();

  @override
  Widget build(BuildContext context) {
    return Consumer<AuthProvider>(
      builder: (context, auth, _) {
        if (auth.status == AuthStatus.unknown) {
          return const SplashScreen();
        }
        if (auth.status == AuthStatus.locked) {
          return const MpinLockScreen();
        }
        if (auth.status == AuthStatus.authenticated) {
          // FF-217b + FF-217c: newly-registered owners land in the
          // setup wizard, but a returning owner with an existing
          // business (menu items / tables in DB) must go straight to
          // HomeScreen even if their row hasn't had its `onboarded`
          // flag flipped yet. `_OnboardingGate` handles that dance.
          return const _OnboardingGate();
        }
        return const LoginScreen();
      },
    );
  }
}

/// FF-217c — decides between the wizard and HomeScreen after login.
/// If the business row says `onboarded=false` we double-check the
/// backend for existing menu/tables; if either has content we flip
/// the flag silently and skip the wizard. This handles pre-existing
/// accounts that never went through the new flow.
class _OnboardingGate extends StatefulWidget {
  const _OnboardingGate();
  @override
  State<_OnboardingGate> createState() => _OnboardingGateState();
}

class _OnboardingGateState extends State<_OnboardingGate> {
  bool? _showWizard;  // null = still checking

  @override
  void initState() {
    super.initState();
    _decide();
  }

  Future<void> _decide() async {
    final auth = context.read<AuthProvider>();
    final biz = auth.business;
    if (biz == null) { setState(() => _showWizard = false); return; }
    if (biz.onboarded) { setState(() => _showWizard = false); return; }
    // onboarded=false — probe for existing data before showing the wizard.
    try {
      final menu = await ApiService.instance.listMenu(biz.id);
      final tables = await ApiService.instance.listOpsTables(biz.id);
      if (menu.isNotEmpty || tables.isNotEmpty) {
        // Existing account misclassified as new — mark onboarded and go home.
        await ApiService.instance.updateMyBusiness({'onboarded': true});
        if (mounted) setState(() => _showWizard = false);
        return;
      }
    } catch (_) {
      // If the probe fails, fall through to the wizard — the user can
      // still hit "Skip" if they don't want to onboard right now.
    }
    if (mounted) setState(() => _showWizard = true);
  }

  @override
  Widget build(BuildContext context) {
    if (_showWizard == null) return const SplashScreen();
    return _showWizard! ? const SetupWizardScreen() : const HomeScreen();
  }
}
