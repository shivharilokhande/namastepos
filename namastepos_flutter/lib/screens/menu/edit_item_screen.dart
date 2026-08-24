// NamastePOS - Add / edit a menu item

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'package:uuid/uuid.dart';

import '../../constants/colors.dart';
import '../../models/menu_item.dart';
import '../../providers/auth_provider.dart';
import '../../providers/menu_provider.dart';
import '../../utils/validators.dart';
import '../../widgets/primary_button.dart';

class EditItemScreen extends StatefulWidget {
  final MenuItem? item;
  const EditItemScreen({super.key, this.item});

  @override
  State<EditItemScreen> createState() => _EditItemScreenState();
}

class _EditItemScreenState extends State<EditItemScreen> {
  final _form = GlobalKey<FormState>();
  late TextEditingController _name;
  late TextEditingController _category;
  late TextEditingController _price;
  late TextEditingController _cost;
  late TextEditingController _stock;
  late TextEditingController _reorder;
  late TextEditingController _sku;
  late TextEditingController _desc;
  MenuUnit _unit = MenuUnit.piece;
  bool _isVeg = true;
  bool _isActive = true;

  @override
  void initState() {
    super.initState();
    final it = widget.item;
    _name = TextEditingController(text: it?.name);
    _category = TextEditingController(text: it?.category ?? 'Food');
    _price = TextEditingController(text: it?.price.toStringAsFixed(0));
    _cost = TextEditingController(text: it?.costPrice?.toStringAsFixed(0));
    _stock = TextEditingController(text: it?.stock.toStringAsFixed(0));
    _reorder = TextEditingController(text: it?.reorderLevel.toStringAsFixed(0) ?? '10');
    _sku = TextEditingController(text: it?.sku);
    _desc = TextEditingController(text: it?.description);
    _unit = it?.unit ?? MenuUnit.piece;
    _isVeg = it?.isVeg ?? true;
    _isActive = it?.isActive ?? true;
  }

  @override
  void dispose() {
    _name.dispose(); _category.dispose(); _price.dispose(); _cost.dispose();
    _stock.dispose(); _reorder.dispose(); _sku.dispose(); _desc.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (!_form.currentState!.validate()) return;
    final biz = context.read<AuthProvider>().business;
    if (biz == null) return;
    final now = DateTime.now();
    final newItem = MenuItem(
      id: widget.item?.id ?? const Uuid().v4(),
      businessId: biz.id,
      name: _name.text.trim(),
      description: _desc.text.trim().isEmpty ? null : _desc.text.trim(),
      category: _category.text.trim(),
      price: double.tryParse(_price.text.trim()) ?? 0,
      costPrice: double.tryParse(_cost.text.trim()),
      stock: double.tryParse(_stock.text.trim()) ?? 0,
      reorderLevel: double.tryParse(_reorder.text.trim()) ?? 10,
      sku: _sku.text.trim().isEmpty ? null : _sku.text.trim(),
      unit: _unit,
      isActive: _isActive,
      isVeg: _isVeg,
      createdAt: widget.item?.createdAt ?? now,
      updatedAt: now,
    );
    await context.read<MenuProvider>().upsert(newItem, isNew: widget.item == null);
    if (mounted) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.item == null ? 'Add item' : 'Edit item'),
      ),
      body: Form(
        key: _form,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            _label('Item name'),
            TextFormField(
              controller: _name,
              validator: (v) => Validators.required(v, label: 'Name'),
              decoration: const InputDecoration(hintText: 'Masala Dosa'),
            ),
            const SizedBox(height: 14),
            _label('Category'),
            TextFormField(
              controller: _category,
              decoration: const InputDecoration(hintText: 'Food / Beverage / Dessert'),
            ),
            const SizedBox(height: 14),
            Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      _label('Price (₹)'),
                      TextFormField(
                        controller: _price,
                        keyboardType: const TextInputType.numberWithOptions(decimal: true),
                        inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))],
                        validator: Validators.positiveNumber,
                        decoration: const InputDecoration(hintText: '80'),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      _label('Cost (₹)'),
                      TextFormField(
                        controller: _cost,
                        keyboardType: const TextInputType.numberWithOptions(decimal: true),
                        inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))],
                        decoration: const InputDecoration(hintText: 'optional'),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 14),
            Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      _label('Stock'),
                      TextFormField(
                        controller: _stock,
                        keyboardType: const TextInputType.numberWithOptions(decimal: true),
                        decoration: const InputDecoration(hintText: '50'),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      _label('Reorder level'),
                      TextFormField(
                        controller: _reorder,
                        keyboardType: const TextInputType.numberWithOptions(decimal: true),
                        decoration: const InputDecoration(hintText: '10'),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 14),
            _label('Unit'),
            DropdownButtonFormField<MenuUnit>(
              value: _unit,
              items: MenuUnit.values.map((u) => DropdownMenuItem(
                value: u,
                child: Text(u.name),
              )).toList(),
              onChanged: (v) => setState(() => _unit = v ?? MenuUnit.piece),
            ),
            const SizedBox(height: 14),
            _label('SKU / code (optional)'),
            TextFormField(controller: _sku),
            const SizedBox(height: 14),
            _label('Description (optional)'),
            TextFormField(controller: _desc, maxLines: 3),
            const SizedBox(height: 8),
            SwitchListTile(
              value: _isVeg,
              onChanged: (v) => setState(() => _isVeg = v),
              title: const Text('Vegetarian'),
              contentPadding: EdgeInsets.zero,
            ),
            SwitchListTile(
              value: _isActive,
              onChanged: (v) => setState(() => _isActive = v),
              title: const Text('Active (visible in POS)'),
              contentPadding: EdgeInsets.zero,
            ),
            const SizedBox(height: 16),
            PrimaryButton(label: widget.item == null ? 'Add item' : 'Save changes', onPressed: _save),
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
