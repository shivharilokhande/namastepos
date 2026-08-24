// NamastePOS - Business info edit

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../providers/auth_provider.dart';
import '../../utils/validators.dart';
import '../../widgets/primary_button.dart';

class BusinessInfoScreen extends StatefulWidget {
  const BusinessInfoScreen({super.key});

  @override
  State<BusinessInfoScreen> createState() => _BusinessInfoScreenState();
}

class _BusinessInfoScreenState extends State<BusinessInfoScreen> {
  final _form = GlobalKey<FormState>();
  late TextEditingController _name;
  late TextEditingController _address;
  late TextEditingController _city;
  late TextEditingController _gstin;
  late TextEditingController _upi;
  late TextEditingController _bank;
  late TextEditingController _ifsc;

  @override
  void initState() {
    super.initState();
    final b = context.read<AuthProvider>().business;
    _name = TextEditingController(text: b?.name);
    _address = TextEditingController(text: b?.address);
    _city = TextEditingController(text: b?.city);
    _gstin = TextEditingController(text: b?.gstin);
    _upi = TextEditingController(text: b?.upiId);
    _bank = TextEditingController(text: b?.bankAccount);
    _ifsc = TextEditingController(text: b?.bankIfsc);
  }

  @override
  void dispose() {
    _name.dispose(); _address.dispose(); _city.dispose(); _gstin.dispose();
    _upi.dispose(); _bank.dispose(); _ifsc.dispose();
    super.dispose();
  }

  bool _saving = false;

  Future<void> _save() async {
    if (!_form.currentState!.validate()) return;
    final auth = context.read<AuthProvider>();
    final cur = auth.business;
    if (cur == null) return;
    setState(() => _saving = true);
    final ok = await auth.updateBusiness(cur.copyWith(
      name: _name.text.trim(),
      address: _address.text.trim(),
      city: _city.text.trim(),
      gstin: _gstin.text.trim(),
      upiId: _upi.text.trim(),
      bankAccount: _bank.text.trim(),
      bankIfsc: _ifsc.text.trim(),
    ));
    if (!mounted) return;
    setState(() => _saving = false);
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(ok
          ? 'Business info saved'
          : 'Could not save: ${auth.error ?? "unknown error"}'),
      backgroundColor: ok ? null : AppColors.error,
    ));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Business info')),
      body: Form(
        key: _form,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            _label('Business name'),
            TextFormField(
              controller: _name,
              validator: (v) => Validators.required(v, label: 'Name'),
            ),
            const SizedBox(height: 14),
            _label('Address (appears on receipt)'),
            TextFormField(controller: _address, maxLines: 2),
            const SizedBox(height: 14),
            _label('City'),
            TextFormField(controller: _city),
            const SizedBox(height: 14),
            _label('GSTIN (optional)'),
            TextFormField(controller: _gstin),
            const SizedBox(height: 14),
            _label('UPI ID (for receipts)'),
            TextFormField(
              controller: _upi,
              decoration: const InputDecoration(hintText: 'yourbusiness@upi'),
            ),
            const SizedBox(height: 14),
            _label('Bank account'),
            TextFormField(controller: _bank),
            const SizedBox(height: 14),
            _label('IFSC'),
            TextFormField(controller: _ifsc),
            const SizedBox(height: 24),
            PrimaryButton(
              label: 'Save changes',
              loading: _saving,
              onPressed: _saving ? null : _save,
            ),
          ],
        ),
      ),
    );
  }

  Widget _label(String s) => Padding(
        padding: const EdgeInsets.only(bottom: 6),
        child: Text(s, style: const TextStyle(
          fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.textPrimary,
        )),
      );
}
