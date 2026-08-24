// NamastePOS - First-run onboarding (after sign-up, capture business details)

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../providers/auth_provider.dart';
import '../../utils/validators.dart';
import '../../widgets/primary_button.dart';
import '../home/home_screen.dart';

class OnboardingScreen extends StatefulWidget {
  const OnboardingScreen({super.key});

  @override
  State<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends State<OnboardingScreen> {
  final _form = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _city = TextEditingController();
  String _category = 'tea-stall';

  @override
  void dispose() {
    _name.dispose();
    _city.dispose();
    super.dispose();
  }

  Future<void> _continue() async {
    if (!_form.currentState!.validate()) return;
    final auth = context.read<AuthProvider>();
    final current = auth.business;
    if (current == null) return;
    final updated = current.copyWith(
      name: _name.text.trim(),
      city: _city.text.trim(),
      category: _category,
    );
    auth.updateBusiness(updated);
    if (!mounted) return;
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute(builder: (_) => const HomeScreen()),
      (_) => false,
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Set up your business')),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Form(
            key: _form,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Tell us about your business',
                  style: TextStyle(
                    fontSize: 22, fontWeight: FontWeight.w700,
                    color: AppColors.textPrimary,
                  ),
                ),
                const SizedBox(height: 4),
                const Text(
                  'This appears on receipts and reports.',
                  style: TextStyle(color: AppColors.textSecondary),
                ),
                const SizedBox(height: 24),
                _label('Business name'),
                TextFormField(
                  controller: _name,
                  validator: (v) => Validators.required(v, label: 'Name'),
                  decoration: const InputDecoration(hintText: 'Sharma Tea Stall'),
                ),
                const SizedBox(height: 16),
                _label('City'),
                TextFormField(
                  controller: _city,
                  validator: (v) => Validators.required(v, label: 'City'),
                  decoration: const InputDecoration(hintText: 'Mumbai'),
                ),
                const SizedBox(height: 16),
                _label('Business type'),
                DropdownButtonFormField<String>(
                  value: _category,
                  items: const [
                    DropdownMenuItem(value: 'tea-stall', child: Text('Tea stall / Cafe')),
                    DropdownMenuItem(value: 'cloud-kitchen', child: Text('Cloud kitchen')),
                    DropdownMenuItem(value: 'dhaba', child: Text('Dhaba / Restaurant')),
                    DropdownMenuItem(value: 'sweet-shop', child: Text('Sweet shop / Bakery')),
                    DropdownMenuItem(value: 'street-food', child: Text('Street food cart')),
                    DropdownMenuItem(value: 'other', child: Text('Other')),
                  ],
                  onChanged: (v) => setState(() => _category = v ?? 'tea-stall'),
                ),
                const Spacer(),
                PrimaryButton(label: 'Continue', onPressed: _continue),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _label(String s) => Padding(
        padding: const EdgeInsets.only(bottom: 6),
        child: Text(
          s,
          style: const TextStyle(
            fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.textPrimary,
          ),
        ),
      );
}
