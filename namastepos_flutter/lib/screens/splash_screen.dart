// NamastePOS - Splash screen shown while bootstrapping auth state

import 'package:flutter/material.dart';
import '../constants/colors.dart';
import '../constants/strings.dart';

class SplashScreen extends StatelessWidget {
  const SplashScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.primary,
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Container(
              width: 96, height: 96,
              decoration: BoxDecoration(
                color: Colors.white.withValues(alpha: 0.15),
                borderRadius: BorderRadius.circular(28),
              ),
              child: const Icon(Icons.restaurant_menu_rounded,
                  size: 56, color: Colors.white),
            ),
            const SizedBox(height: 18),
            const Text(
              AppStrings.appName,
              style: TextStyle(
                fontSize: 32, fontWeight: FontWeight.w800,
                color: Colors.white, letterSpacing: -0.5,
              ),
            ),
            const SizedBox(height: 4),
            const Text(
              AppStrings.tagline,
              style: TextStyle(
                fontSize: 14, color: Colors.white70, fontWeight: FontWeight.w500,
              ),
            ),
            const SizedBox(height: 36),
            const SizedBox(
              width: 28, height: 28,
              child: CircularProgressIndicator(strokeWidth: 3, color: Colors.white),
            ),
          ],
        ),
      ),
    );
  }
}
