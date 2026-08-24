// NamastePOS - Color palette

import 'package:flutter/material.dart';

class AppColors {
  AppColors._();

  // Brand
  static const Color primary = Color(0xFFFF6B35);        // NamastePOS Orange
  static const Color primaryDark = Color(0xFFE85525);
  static const Color primaryLight = Color(0xFFFF8B5A);
  static const Color secondary = Color(0xFF2EC4B6);      // Teal
  static const Color accent = Color(0xFFFFB627);         // Saffron yellow

  // Surfaces
  static const Color background = Color(0xFFF7F8FA);
  static const Color surface = Colors.white;
  static const Color card = Colors.white;
  static const Color divider = Color(0xFFE5E7EB);
  static const Color border  = Color(0xFFE5E7EB);

  // Text
  static const Color textPrimary = Color(0xFF111827);
  static const Color textSecondary = Color(0xFF6B7280);
  static const Color textHint = Color(0xFF9CA3AF);
  static const Color textInverse = Colors.white;

  // States
  static const Color success = Color(0xFF10B981);
  static const Color warning = Color(0xFFF59E0B);
  static const Color error = Color(0xFFEF4444);
  static const Color info = Color(0xFF3B82F6);

  // Order Statuses
  static const Color statusPending = Color(0xFFF59E0B);
  static const Color statusReady = Color(0xFF10B981);
  static const Color statusCollected = Color(0xFF6B7280);
  static const Color statusCancelled = Color(0xFFEF4444);

  // Revenue source palette (for charts)
  static const List<Color> chartPalette = [
    Color(0xFFFF6B35),
    Color(0xFF2EC4B6),
    Color(0xFFFFB627),
    Color(0xFF8B5CF6),
    Color(0xFF3B82F6),
    Color(0xFFEC4899),
  ];

  // Dark mode (POS owners may use in dim kitchens)
  static const Color darkBackground = Color(0xFF111827);
  static const Color darkSurface = Color(0xFF1F2937);
  static const Color darkCard = Color(0xFF374151);
}
