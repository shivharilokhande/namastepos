// NamastePOS - Add a new expense

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../models/expense.dart';
import '../../providers/auth_provider.dart';
import '../../providers/expenses_provider.dart';
import '../../utils/validators.dart';
import '../../widgets/primary_button.dart';

class AddExpenseScreen extends StatefulWidget {
  const AddExpenseScreen({super.key});

  @override
  State<AddExpenseScreen> createState() => _AddExpenseScreenState();
}

class _AddExpenseScreenState extends State<AddExpenseScreen> {
  final _form = GlobalKey<FormState>();
  final _amount = TextEditingController();
  final _desc = TextEditingController();
  DateTime _date = DateTime.now();
  ExpenseCategory _category = ExpenseCategory.ingredients;

  @override
  void dispose() {
    _amount.dispose();
    _desc.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (!_form.currentState!.validate()) return;
    final biz = context.read<AuthProvider>().business;
    if (biz == null) return;
    await context.read<ExpensesProvider>().add(
          businessId: biz.id,
          category: _category,
          amount: double.parse(_amount.text.trim()),
          description: _desc.text.trim(),
          date: _date,
        );
    if (mounted) Navigator.pop(context);
  }

  Future<void> _pickDate() async {
    final d = await showDatePicker(
      context: context,
      initialDate: _date,
      firstDate: DateTime(2020),
      lastDate: DateTime.now(),
    );
    if (d != null) setState(() => _date = d);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('New Expense')),
      body: Form(
        key: _form,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            _label('Category'),
            DropdownButtonFormField<ExpenseCategory>(
              value: _category,
              // Overflow fix (2026-08-25): the category list grew long (Chef
              // Salary, Gas, Electricity, …) and the default popup tried to
              // render every row at once, pushing content off-screen.
              // isExpanded makes the field fill its width; menuMaxHeight caps
              // the popup so it SCROLLS instead of overflowing the screen.
              isExpanded: true,
              menuMaxHeight: 320,
              items: ExpenseCategory.values
                  .where((c) => c.userSelectable)
                  .map((c) => DropdownMenuItem(
                value: c, child: Text(c.label),
              )).toList(),
              onChanged: (v) => setState(() => _category = v ?? ExpenseCategory.other),
            ),
            const SizedBox(height: 14),
            _label('Amount (₹)'),
            TextFormField(
              controller: _amount,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))],
              validator: Validators.positiveNumber,
              decoration: const InputDecoration(hintText: '500'),
            ),
            const SizedBox(height: 14),
            _label('Description'),
            TextFormField(
              controller: _desc,
              decoration: const InputDecoration(hintText: 'e.g. Rice, oil, masala'),
              maxLines: 2,
            ),
            const SizedBox(height: 14),
            _label('Date'),
            InkWell(
              onTap: _pickDate,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
                decoration: BoxDecoration(
                  color: AppColors.surface,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: AppColors.divider),
                ),
                child: Row(
                  children: [
                    const Icon(Icons.calendar_today_outlined, size: 18),
                    const SizedBox(width: 10),
                    Text(DateFormat('dd MMM yyyy').format(_date)),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 24),
            PrimaryButton(label: 'Save expense', onPressed: _save),
          ],
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
