// NamastePOS — First-login feature tour (2026-08-25).
//
// A complete walkthrough of the app's important features, shown ONCE
// after the owner's first login/registration. Each step flips the real
// bottom-nav tab (via the shared `homeTabIndex` notifier) so the user
// sees the actual screen being described. Persisted with
// SharedPreferences so returning users never see it again; "Skip"
// bails at any point. No third-party tour package.

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../constants/colors.dart';
import 'home_bottom_nav.dart';

const String _kSeenKey = 'np_seen_feature_tour_v2';

class _TourStep {
  final int? tab; // bottom-nav tab to show for this step (null = stay)
  final String title;
  final String body;
  const _TourStep({this.tab, required this.title, required this.body});
}

const List<_TourStep> _steps = [
  _TourStep(
    tab: 0,
    title: 'Welcome to NamastePOS 🎉',
    body: 'A quick tour of everything important — under a minute. '
        'This Home tab shows today\'s sales, orders and alerts at a glance.',
  ),
  _TourStep(
    tab: 1,
    title: 'POS — take orders here',
    body: 'Walk-ins, phone orders, dine-in: tap items, pick the table, '
        'and bill in seconds. Works offline too — orders sync when you\'re back online.',
  ),
  _TourStep(
    tab: 2,
    title: 'Orders — everything in one list',
    body: 'Every order lands here — POS, QR-scan orders from customers\' phones, '
        'and Zomato/Swiggy once connected. Track status from new → served → paid.',
  ),
  _TourStep(
    tab: 3,
    title: 'Tables & captain view',
    body: 'See your floor live: which tables are free, occupied, or waiting '
        'to pay. Each table gets a QR code customers can order from.',
  ),
  _TourStep(
    tab: 4,
    title: 'Reports — know your business',
    body: 'Daily sales, best sellers, GST summaries and expenses. '
        'Everything you need at tax time, updated live.',
  ),
  _TourStep(
    tab: 5,
    title: 'Settings & more',
    body: 'GST details, receipt printer, staff PINs and plan upgrades. '
        'The ☰ menu (top-left) has even more: Kitchen board, Customers, '
        'Inventory, Daily closing. That\'s the tour — take your first order!',
  ),
];

/// Overlay card pinned to the bottom of HomeScreen. Include it in a
/// Stack ABOVE the IndexedStack. Renders nothing once seen/skipped.
class FeatureTour extends StatefulWidget {
  const FeatureTour({super.key});

  @override
  State<FeatureTour> createState() => _FeatureTourState();
}

class _FeatureTourState extends State<FeatureTour> {
  int _step = 0;
  bool _visible = false;

  @override
  void initState() {
    super.initState();
    _maybeShow();
  }

  Future<void> _maybeShow() async {
    final prefs = await SharedPreferences.getInstance();
    if (prefs.getBool(_kSeenKey) ?? false) return;
    // Give the home screen a beat to paint before the card drops in.
    await Future.delayed(const Duration(milliseconds: 1100));
    if (!mounted) return;
    homeTabIndex.value = _steps.first.tab ?? 0;
    setState(() => _visible = true);
  }

  Future<void> _finish() async {
    setState(() => _visible = false);
    homeTabIndex.value = 0; // land the user back on Home
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_kSeenKey, true);
  }

  void _go(int delta) {
    final n = _step + delta;
    if (n < 0) return;
    if (n >= _steps.length) {
      _finish();
      return;
    }
    setState(() => _step = n);
    final tab = _steps[n].tab;
    if (tab != null) homeTabIndex.value = tab;
  }

  @override
  Widget build(BuildContext context) {
    if (!_visible) return const SizedBox.shrink();
    final s = _steps[_step];
    final last = _step == _steps.length - 1;
    return Positioned(
      left: 12,
      right: 12,
      bottom: 12,
      child: Material(
        elevation: 12,
        borderRadius: BorderRadius.circular(16),
        color: Theme.of(context).colorScheme.surface,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Text('FEATURE TOUR · ${_step + 1}/${_steps.length}',
                      style: const TextStyle(
                          fontSize: 11,
                          letterSpacing: 1.1,
                          fontWeight: FontWeight.w700,
                          color: AppColors.primary)),
                  const Spacer(),
                  InkWell(
                    onTap: _finish,
                    child: const Padding(
                      padding: EdgeInsets.all(4),
                      child: Icon(Icons.close, size: 18),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              Text(s.title,
                  style: const TextStyle(
                      fontSize: 16, fontWeight: FontWeight.w800)),
              const SizedBox(height: 6),
              Text(s.body,
                  style: const TextStyle(
                      fontSize: 13, height: 1.45,
                      color: AppColors.textSecondary)),
              const SizedBox(height: 12),
              Row(
                children: [
                  TextButton(
                    onPressed: _finish,
                    child: const Text('Skip',
                        style: TextStyle(fontSize: 12)),
                  ),
                  const Spacer(),
                  if (_step > 0)
                    OutlinedButton(
                      onPressed: () => _go(-1),
                      child: const Text('Back'),
                    ),
                  const SizedBox(width: 8),
                  ElevatedButton(
                    onPressed: () => _go(1),
                    child: Text(last ? 'Finish' : 'Next'),
                  ),
                ],
              ),
              const SizedBox(height: 4),
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: List.generate(_steps.length, (i) {
                  final active = i == _step;
                  return AnimatedContainer(
                    duration: const Duration(milliseconds: 200),
                    margin: const EdgeInsets.symmetric(horizontal: 2.5),
                    height: 5,
                    width: active ? 18 : 5,
                    decoration: BoxDecoration(
                      color: active
                          ? AppColors.primary
                          : AppColors.textHint.withOpacity(0.35),
                      borderRadius: BorderRadius.circular(3),
                    ),
                  );
                }),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
