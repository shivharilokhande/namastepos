// NamastePOS mobile — First-time setup wizard (FF-217b).
//
// Mobile companion to the dashboard SetupWizardPage. FIVE steps since
// 2026-09-05: business profile → GST scheme → floor + tables → menu items →
// done. Uses the
// existing PATCH /auth/me, POST /ops/floors, POST /ops/tables and
// POST /menu endpoints; the final "Finish" tap sets `onboarded=true`
// so this screen never appears again.
//
// Skippable at every step — skip still flips onboarded=true. On finish
// we push HomeScreen with a fresh AuthProvider refresh.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../../utils/error_humanizer.dart';
import '../home/home_screen.dart';
import '../menu/menu_paste_screen.dart';
import '../menu/menu_start_routes.dart';
import '../menu/menu_template_screen.dart';

const _categories = [
  'Café', 'Restaurant', 'QSR', 'Bar', 'Cloud kitchen', 'Bakery', 'Street food', 'Other',
];

class SetupWizardScreen extends StatefulWidget {
  const SetupWizardScreen({super.key});
  @override
  State<SetupWizardScreen> createState() => _SetupWizardScreenState();
}

/// profile, GST scheme, tables, menu, confirm.
const _stepCount = 5;

class _SetupWizardScreenState extends State<SetupWizardScreen> {
  int _step = 0;
  bool _busy = false;

  // Profile
  final _name = TextEditingController();
  final _phone = TextEditingController();
  final _city = TextEditingController();
  String _category = 'Café';
  // FF-252 — business-wide service style. hybrid = per-table decides.
  String _serviceMode = 'hybrid';

  // 2026-09-05 (backend migration 092) — the GST scheme the owner is
  // registered under. Pre-set to 'regular' because that IS the default the
  // database already applies to every account, and pretending otherwise would
  // be the same silent default this step exists to remove. The difference is
  // that the owner now SEES it, with the two alternatives and what each one
  // does to their bills one tap away.
  //
  // Written to the server when the owner leaves this step, NOT at Finish: the
  // menu step comes after, and a starter menu loaded there must pick up the
  // right slab on all 34 items rather than the 5% default.
  String _gstScheme = 'regular';
  bool _gstSaved = false;

  /// Set once a template or a pasted menu actually inserted items, so the
  /// three demo rows below stop being offered as the way to build a menu.
  int _importedCount = 0;

  // Floor + tables
  final _floor = TextEditingController(text: 'Ground floor');
  final List<_Table> _tables = [
    _Table('1', 4), _Table('2', 4), _Table('3', 2),
  ];

  // Menu
  final List<_Item> _items = [
    _Item('Masala Chai', '30'),
    _Item('Butter Naan', '40'),
    _Item('Paneer Tikka', '250'),
  ];

  /// FF-217c — swallow "already exists" errors so the wizard is
  /// idempotent even when the account already has some data.
  bool _isDuplicate(Object e) {
    final msg = e.toString().toLowerCase();
    return msg.contains('already') || msg.contains('duplicate') ||
           msg.contains('exists') || msg.contains('conflict');
  }

  Future<T?> _swallowDup<T>(Future<T> Function() body) async {
    try { return await body(); } catch (e) {
      if (_isDuplicate(e)) return null;
      rethrow;
    }
  }

  Future<void> _finish() async {
    final auth = context.read<AuthProvider>();
    final biz = auth.business;
    if (biz == null) return;
    setState(() => _busy = true);
    try {
      // 1. Profile — only send fields the user actually typed.
      final patch = <String, dynamic>{
        if (_name.text.trim().isNotEmpty) 'name': _name.text.trim(),
        if (_phone.text.trim().isNotEmpty) 'phone': _phone.text.trim(),
        if (_city.text.trim().isNotEmpty) 'city': _city.text.trim(),
        'category': _category,
        'default_service_mode': _serviceMode,   // FF-252
        // Belt to the braces of _saveGstScheme() below: if that write failed
        // (offline mid-wizard) this second chance still lands the answer.
        'gst_scheme': _gstScheme,
      };
      if (patch.isNotEmpty) {
        await _swallowDup(() => ApiService.instance.updateMyBusiness(patch));
      }

      // 2. Floor + tables — reuse whatever's there already.
      final existingFloors = await ApiService.instance.listFloors(biz.id).catchError((_) => <dynamic>[]);
      final existingTables = await ApiService.instance.listOpsTables(biz.id).catchError((_) => <dynamic>[]);
      final floorNameWanted = _floor.text.trim().isEmpty ? 'Ground floor' : _floor.text.trim();
      Map<String, dynamic>? floor;
      for (final f in existingFloors) {
        final fm = (f as Map).cast<String, dynamic>();
        if ((fm['name'] as String? ?? '').toLowerCase() == floorNameWanted.toLowerCase()) {
          floor = fm; break;
        }
      }
      floor ??= await _swallowDup(() => ApiService.instance.createFloor(biz.id, {'name': floorNameWanted}));
      floor ??= existingFloors.isNotEmpty
          ? (existingFloors.first as Map).cast<String, dynamic>() : null;
      final existingLabels = <String>{
        for (final t in existingTables) ((t as Map)['label'] as String? ?? '').toLowerCase(),
      };
      for (final t in _tables) {
        if (t.label.trim().isEmpty) continue;
        if (existingLabels.contains(t.label.toLowerCase())) continue;
        await _swallowDup(() => ApiService.instance.createOpsTable(biz.id, {
          'label': t.label,
          'seats': t.seats,
          if (floor != null) 'floorId': floor['id'],
        }));
      }

      // 3. Menu items — skip anything that already exists by name.
      final existingMenu = await ApiService.instance.listMenu(biz.id).catchError((_) => <dynamic>[]);
      final existingNames = <String>{
        for (final m in existingMenu) ((m as Map)['name'] as String? ?? '').toLowerCase(),
      };
      for (final it in _items) {
        final n = it.name.trim();
        if (n.isEmpty || existingNames.contains(n.toLowerCase())) continue;
        final price = double.tryParse(it.price) ?? 0;
        await _swallowDup(() => ApiService.instance.upsertMenuItem(biz.id, {
          'name': n,
          'price': price,
        }));
      }

      // 4. Mark onboarded — flips the gate so the wizard never returns.
      await ApiService.instance.updateMyBusiness({'onboarded': true});

      if (!mounted) return;
      Navigator.of(context).pushReplacement(
        MaterialPageRoute(builder: (_) => const HomeScreen()),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text("Couldn't finish setup — " + humanizeError(e)),
        backgroundColor: AppColors.error,
      ));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Continue. Everything except the GST step is a pure state change; the GST
  /// answer is written to the server on the way out of step 1 so the menu step
  /// that follows creates items at the right slab.
  Future<void> _advance() async {
    if (_step == 1) await _saveGstScheme();
    if (!mounted) return;
    setState(() => _step += 1);
  }

  /// PATCH the declared scheme. Deliberately NOT fatal: an owner on a café
  /// connection must not be trapped on step 2 of setup because one field did
  /// not save. _finish() sends `gst_scheme` again in its profile patch, so the
  /// answer still lands; all that is lost in the meantime is the correct
  /// default on items created in between, which the owner can fix per item.
  Future<void> _saveGstScheme() async {
    if (_gstSaved) return;
    final auth = context.read<AuthProvider>();
    setState(() => _busy = true);
    final ok = await auth.setGstScheme(_gstScheme);
    if (!mounted) return;
    setState(() { _busy = false; _gstSaved = ok; });
  }

  Future<void> _skip() async {
    setState(() => _busy = true);
    try {
      await ApiService.instance.updateMyBusiness({'onboarded': true});
      if (!mounted) return;
      Navigator.of(context).pushReplacement(
        MaterialPageRoute(builder: (_) => const HomeScreen()),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(humanizeError(e))),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  void dispose() {
    _name.dispose(); _phone.dispose(); _city.dispose(); _floor.dispose();
    for (final t in _tables) { t.dispose(); }
    for (final i in _items) { i.dispose(); }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: Column(
          children: [
            _header(),
            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(16),
                child: _body(),
              ),
            ),
            _footer(),
          ],
        ),
      ),
    );
  }

  Widget _header() {
    final titles = [
      'Tell us about your business',
      'How is your GST registered?',
      'Add your tables',
      'Add a few menu items',
      'Ready to serve!',
    ];
    return Container(
      padding: const EdgeInsets.fromLTRB(20, 16, 20, 16),
      decoration: const BoxDecoration(
        color: AppColors.surface,
        border: Border(bottom: BorderSide(color: AppColors.divider)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Step ${_step + 1} of 4',
              style: const TextStyle(fontSize: 11, color: AppColors.textSecondary)),
          const SizedBox(height: 4),
          Text(titles[_step],
              style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
          const SizedBox(height: 10),
          Row(
            children: List.generate(_stepCount, (i) => Expanded(
              child: Container(
                margin: EdgeInsets.only(right: i < _stepCount - 1 ? 4 : 0),
                height: 3,
                decoration: BoxDecoration(
                  color: i <= _step ? AppColors.primary : AppColors.divider,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            )),
          ),
        ],
      ),
    );
  }

  Widget _body() {
    switch (_step) {
      case 0: return _step0Profile();
      case 1: return _step1Gst();
      case 2: return _step2Tables();
      case 3: return _step3Menu();
      case 4: return _step4Confirm();
    }
    return const SizedBox.shrink();
  }

  Widget _step0Profile() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextField(controller: _name,
          decoration: const InputDecoration(labelText: 'Business name', hintText: 'Cafe Sugar & Spice')),
        const SizedBox(height: 12),
        TextField(controller: _phone,
          keyboardType: TextInputType.number,
          inputFormatters: [
            FilteringTextInputFormatter.digitsOnly,
            LengthLimitingTextInputFormatter(10),
          ],
          decoration: const InputDecoration(labelText: 'Phone', hintText: '9876543210', counterText: '')),
        const SizedBox(height: 12),
        TextField(controller: _city,
          decoration: const InputDecoration(labelText: 'City')),
        const SizedBox(height: 12),
        DropdownButtonFormField<String>(
          value: _category,
          items: _categories.map((c) => DropdownMenuItem(value: c, child: Text(c))).toList(),
          onChanged: (v) => setState(() => _category = v ?? 'Café'),
          decoration: const InputDecoration(labelText: 'Category'),
        ),
        const SizedBox(height: 12),
        // FF-252 — service style picker. Controls what happens when
        // the kitchen marks an order ready (dine-in silences the
        // "come collect" WhatsApp, self-pickup keeps it).
        DropdownButtonFormField<String>(
          value: _serviceMode,
          items: const [
            DropdownMenuItem(value: 'dine_in',
              child: Text('Dine-in — waiter serves at the table')),
            DropdownMenuItem(value: 'self_pickup',
              child: Text('Self-pickup — guest collects at counter')),
            DropdownMenuItem(value: 'hybrid',
              child: Text('Both — set style per table later')),
          ],
          onChanged: (v) => setState(() => _serviceMode = v ?? 'hybrid'),
          decoration: const InputDecoration(
            labelText: 'How do customers get their food?',
          ),
        ),
      ],
    );
  }

  // ── Step 1 — the GST question (2026-09-05) ────────────────────────────
  //
  // WHY THIS IS A WHOLE STEP AND NOT A DROPDOWN ON THE PROFILE PAGE.
  // Until today a loaded template defaulted every item to 5% and that default
  // was the owner's ONLY signal about what they were charging. This one tap
  // decides whether every bill they print for the next year is correct. It
  // gets its own screen because it deserves to be read, not scrolled past.
  //
  // WHAT THE COPY DELIBERATELY DOES NOT SAY: no turnover threshold, no
  // notification number, no "you qualify if…". Those limits move, they have
  // per-state variation, and a wrong number here would put a wrong rate on
  // every bill of every owner who believed it. The owner already knows which
  // scheme they registered under; for the edges we point at their CA, the way
  // the blog posts do. Nothing infers the scheme from anything.
  Widget _step1Gst() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Text(
          'This sets the GST on new menu items and on the bills you print. '
          'Pick what you are actually registered under — you can change it '
          'later in Settings.',
          style: TextStyle(fontSize: 13, color: AppColors.textSecondary),
        ),
        const SizedBox(height: 14),
        _gstOption(
          value: 'regular',
          title: 'Regular scheme — 5% GST on the bill',
          body: 'No input tax credit. This is how most restaurants, cafés and '
              'takeaways are registered, and it is what your menu uses today.',
        ),
        const SizedBox(height: 10),
        _gstOption(
          value: 'composition',
          title: 'Composition scheme — no GST on the bill',
          body: 'You pay GST yourself on turnover and charge the customer '
              'nothing. Your bills are a BILL OF SUPPLY, not a tax invoice. '
              'Pick this and we will not add GST to any bill.',
        ),
        const SizedBox(height: 10),
        _gstOption(
          value: 'specified_premises',
          title: 'Specified premises — 18% GST on the bill',
          body: 'With input tax credit. Mainly restaurants inside '
              'higher-tariff hotel premises, and those who have opted in.',
        ),
        const SizedBox(height: 16),
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: AppColors.info.withValues(alpha: 0.07),
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: AppColors.info.withValues(alpha: 0.3)),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: const [
              Icon(Icons.info_outline, size: 15, color: AppColors.info),
              SizedBox(width: 8),
              Expanded(
                child: Text(
                  'Not sure which one you are on? Ask your CA before you start '
                  'billing — the registration you hold decides this, not us, '
                  'and we would rather you check than guess. Leaving it on '
                  'Regular keeps exactly the 5% behaviour you have now.',
                  style: TextStyle(fontSize: 11.5, height: 1.4),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _gstOption({
    required String value,
    required String title,
    required String body,
  }) {
    final selected = _gstScheme == value;
    return Material(
      color: selected
          ? AppColors.primary.withValues(alpha: 0.06)
          : AppColors.surface,
      borderRadius: BorderRadius.circular(12),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        // Any change re-arms the write, so going Back and picking again is
        // not silently ignored by the _gstSaved guard.
        onTap: () => setState(() { _gstScheme = value; _gstSaved = false; }),
        child: Container(
          padding: const EdgeInsets.all(13),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(12),
            border: Border.all(
              color: selected ? AppColors.primary : AppColors.divider,
              width: selected ? 1.5 : 1,
            ),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(
                selected
                    ? Icons.radio_button_checked
                    : Icons.radio_button_unchecked,
                size: 19,
                color: selected ? AppColors.primary : AppColors.textHint,
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title,
                        style: const TextStyle(
                            fontWeight: FontWeight.w800, fontSize: 13.5)),
                    const SizedBox(height: 4),
                    Text(body,
                        style: const TextStyle(
                            fontSize: 12,
                            height: 1.35,
                            color: AppColors.textSecondary)),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _step2Tables() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextField(controller: _floor,
          decoration: const InputDecoration(labelText: 'Floor name')),
        const SizedBox(height: 12),
        Text('Tables (${_tables.length})',
            style: const TextStyle(fontWeight: FontWeight.w700)),
        const SizedBox(height: 6),
        ..._tables.asMap().entries.map((e) {
          final i = e.key;
          final t = e.value;
          return Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Row(children: [
              SizedBox(width: 60, child: TextField(
                controller: t.labelCtrl,
                onChanged: (v) => t.label = v,
                decoration: const InputDecoration(hintText: 'Label'),
              )),
              const SizedBox(width: 8),
              SizedBox(width: 80, child: TextField(
                controller: t.seatsCtrl,
                keyboardType: TextInputType.number,
                onChanged: (v) => t.seats = int.tryParse(v) ?? 4,
                decoration: const InputDecoration(hintText: 'Seats'),
              )),
              const SizedBox(width: 6),
              const Text('seats', style: TextStyle(color: AppColors.textSecondary, fontSize: 12)),
              const Spacer(),
              IconButton(icon: const Icon(Icons.close, size: 18),
                // P2 fix (2026-08-22): dispose the removed row's
                // controllers after the frame (they're gone from the
                // lists, so state dispose() would leak them).
                onPressed: () {
                  final removed = _tables[i];
                  setState(() => _tables.removeAt(i));
                  WidgetsBinding.instance.addPostFrameCallback((_) => removed.dispose());
                }),
            ]),
          );
        }),
        Align(alignment: Alignment.centerLeft,
          child: TextButton.icon(
            icon: const Icon(Icons.add, size: 16),
            label: const Text('Add table'),
            onPressed: () => setState(() =>
              _tables.add(_Table((_tables.length + 1).toString(), 4))),
          ),
        ),
      ],
    );
  }

  Widget _step3Menu() {
    // Once a template or a pasted menu has actually landed, the three demo
    // rows are noise — and worse, they read as "here is the work still ahead"
    // to an owner who just finished it in one tap.
    if (_importedCount > 0) return _menuImported();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // 2026-09-05 — the three routes, offered BEFORE the three empty rows.
        // Most owners reach this screen on a phone from a WhatsApp link; a
        // full menu typed here is 45-90 minutes and it is where trials end on
        // day one. Putting the shortcuts underneath the rows would be the same
        // as not shipping them.
        const Text('Get your menu in',
            style: TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
        const SizedBox(height: 8),
        MenuStartRoutes(
          dense: true,
          manualLabel: 'Type a few now',
          manualSubtitle: 'Use the rows below. Add the rest any time.',
          onPick: _wizardMenuRoute,
        ),
        const SizedBox(height: 18),
        const Divider(height: 1),
        const SizedBox(height: 14),
        Text('Or type them here (${_items.length})',
            style: const TextStyle(fontWeight: FontWeight.w700)),
        const SizedBox(height: 6),
        ..._items.asMap().entries.map((e) {
          final i = e.key;
          final it = e.value;
          return Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Row(children: [
              Expanded(child: TextField(
                controller: it.nameCtrl,
                onChanged: (v) => it.name = v,
                decoration: const InputDecoration(hintText: 'Item name'),
              )),
              const SizedBox(width: 8),
              SizedBox(width: 90, child: TextField(
                controller: it.priceCtrl,
                keyboardType: TextInputType.number,
                onChanged: (v) => it.price = v,
                decoration: const InputDecoration(hintText: '₹'),
              )),
              IconButton(icon: const Icon(Icons.close, size: 18),
                onPressed: () {
                  final removed = _items[i];
                  setState(() => _items.removeAt(i));
                  WidgetsBinding.instance.addPostFrameCallback((_) => removed.dispose());
                }),
            ]),
          );
        }),
        Align(alignment: Alignment.centerLeft,
          child: TextButton.icon(
            icon: const Icon(Icons.add, size: 16),
            label: const Text('Add item'),
            onPressed: () => setState(() => _items.add(_Item('', ''))),
          ),
        ),
        const SizedBox(height: 12),
        const Text(
          'Tip: you can bulk-import a CSV from the Menu screen later.',
          style: TextStyle(fontSize: 11, color: AppColors.textHint),
        ),
      ],
    );
  }

  /// Shown once a template or a paste actually inserted items.
  Widget _menuImported() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: AppColors.success.withValues(alpha: 0.08),
            borderRadius: BorderRadius.circular(12),
            border:
                Border.all(color: AppColors.success.withValues(alpha: 0.4)),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Icon(Icons.check_circle_outline,
                  size: 20, color: AppColors.success),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '$_importedCount item'
                      '${_importedCount == 1 ? '' : 's'} are in your menu',
                      style: const TextStyle(
                          fontWeight: FontWeight.w800, fontSize: 14),
                    ),
                    const SizedBox(height: 4),
                    const Text(
                      'Prices, categories and GST are all editable from the '
                      'Menu screen — tap any item to change it.',
                      style: TextStyle(
                          fontSize: 12,
                          height: 1.35,
                          color: AppColors.textSecondary),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton.icon(
            icon: const Icon(Icons.add, size: 16),
            label: const Text('Add more items'),
            onPressed: () => setState(() => _importedCount = 0),
          ),
        ),
      ],
    );
  }

  /// The wizard's own dispatch for the three routes. Differs from the menu
  /// screen's in one way: an import that lands clears the three pre-filled
  /// demo rows, so _finish() does not then push Masala Chai into a menu the
  /// owner just filled properly.
  Future<void> _wizardMenuRoute(MenuStartRoute route) async {
    if (route == MenuStartRoute.manual) {
      // Nothing to open — the rows are already on this screen.
      return;
    }
    final inserted = await Navigator.push<int>(
      context,
      MaterialPageRoute(
        builder: (_) => route == MenuStartRoute.template
            ? const MenuTemplateScreen()
            : const MenuPasteScreen(),
      ),
    );
    if (!mounted || inserted == null || inserted <= 0) return;
    final dropped = List<_Item>.from(_items);
    setState(() {
      _importedCount = inserted;
      _items.clear();
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      for (final it in dropped) {
        it.dispose();
      }
    });
  }

  Widget _step4Confirm() {
    final valid = _items.where((i) => i.name.trim().isNotEmpty).length;
    return Center(
      child: Column(children: [
        const SizedBox(height: 24),
        const Text('🎉', style: TextStyle(fontSize: 40)),
        const SizedBox(height: 12),
        Text('Almost there, ${_name.text.trim().isEmpty ? "friend" : _name.text.trim()}!',
            style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
        const SizedBox(height: 8),
        Text(
          "We'll create ${_tables.length} table${_tables.length == 1 ? '' : 's'} on "
          "${_floor.text.trim().isEmpty ? 'Ground floor' : _floor.text.trim()} and "
          "add $valid menu item${valid == 1 ? '' : 's'}. "
          "You can edit everything later from Settings.",
          textAlign: TextAlign.center,
          style: const TextStyle(color: AppColors.textSecondary),
        ),
      ]),
    );
  }

  Widget _footer() {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: const BoxDecoration(
        color: AppColors.surface,
        border: Border(top: BorderSide(color: AppColors.divider)),
      ),
      child: Row(children: [
        TextButton(
          onPressed: _busy ? null : _skip,
          child: const Text('Skip for now',
              style: TextStyle(color: AppColors.textSecondary, fontSize: 12)),
        ),
        const Spacer(),
        if (_step > 0)
          OutlinedButton(
            onPressed: _busy ? null : () => setState(() => _step -= 1),
            child: const Text('Back'),
          ),
        const SizedBox(width: 8),
        ElevatedButton(
          onPressed: _busy ? null : () {
            if (_step < _stepCount - 1) {
              _advance();
            } else {
              _finish();
            }
          },
          child: _busy
              ? const SizedBox(width: 18, height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
              : Text(_step < _stepCount - 1 ? 'Continue' : 'Finish setup'),
        ),
      ]),
    );
  }
}

// P1 fix (2026-08-22): controllers were re-created inline in build()
// via `TextEditingController(text: t.label)`. Every setState wiped the
// caret + dropped focus mid-typing. Now each row model owns its
// controllers, created once in the constructor and disposed in the
// state's dispose(). Callers read `.labelCtrl` / `.seatsCtrl` /
// `.nameCtrl` / `.priceCtrl` in build; the mirror string fields stay
// so existing serialization paths (`t.label`, `it.price`) keep working.
class _Table {
  String label;
  int seats;
  late final TextEditingController labelCtrl;
  late final TextEditingController seatsCtrl;
  _Table(this.label, this.seats) {
    labelCtrl = TextEditingController(text: label);
    seatsCtrl = TextEditingController(text: seats.toString());
  }
  void dispose() { labelCtrl.dispose(); seatsCtrl.dispose(); }
}

class _Item {
  String name;
  String price;
  late final TextEditingController nameCtrl;
  late final TextEditingController priceCtrl;
  _Item(this.name, this.price) {
    nameCtrl = TextEditingController(text: name);
    priceCtrl = TextEditingController(text: price);
  }
  void dispose() { nameCtrl.dispose(); priceCtrl.dispose(); }
}
