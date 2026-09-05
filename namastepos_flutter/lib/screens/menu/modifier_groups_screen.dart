// NamastePOS — Mobile modifier-group catalog (Push 8 / parity with backend).
//
// Modifier groups are the catalog-level objects that menu items attach to
// (e.g. "Spice level", "Toppings", "Extras"). Each group is one of:
//   - single_select: customer picks exactly one (radio)
//   - multi_select : customer picks 0..N (checkboxes), bounded by min/max
//
// Groups contain modifiers, each with a price delta that gets stacked on
// the line total when picked. Once a group exists in the catalog, the
// menu editor can tick it on individual items via the attach UI.
//
// This screen owns CRUD for groups + their nested modifiers. The backend
// uses an upsert endpoint (PUT /modifier-groups) so create + edit share
// the same payload shape.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../constants/feature_keys.dart';
import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../../widgets/home_bottom_nav.dart';
import '../../widgets/plan_gate.dart' show upgradeTargetPhrase;
import '../../widgets/home_drawer_button.dart';

// ──────────────────────────────────────────────────────────────────────────
//                          LIST SCREEN
// ──────────────────────────────────────────────────────────────────────────

class ModifierGroupsScreen extends StatefulWidget {
  const ModifierGroupsScreen({super.key});

  @override
  State<ModifierGroupsScreen> createState() => _ModifierGroupsScreenState();
}

class _ModifierGroupsScreenState extends State<ModifierGroupsScreen> {
  bool _loading = true;
  String? _error;
  List<Map<String, dynamic>> _groups = [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    // Captured before any await — see the note in _save().
    final auth = context.read<AuthProvider>();
    final biz = auth.business;
    if (biz == null) return;
    setState(() { _loading = true; _error = null; });
    try {
      final raw = await ApiService.instance.listAllModifierGroups(biz.id);
      if (!mounted) return; // FB-20: guard setState after await
      setState(() => _groups = raw.cast<Map<String, dynamic>>());
    } on ApiException catch (e) {
      if (!mounted) return; // FB-20
      // 402 here means the business is on Starter — we still show the empty
      // state with a clear hint instead of an angry error screen.
      // The plan name comes from the server's 402 body (requiredTierLabel),
      // never from a guess: "Pro" used to be hardcoded here, and on the live
      // five-plan ladder that is not necessarily the plan that unlocks this.
      setState(() => _error = e.statusCode == 402
          ? 'Modifier groups need '
              '${upgradeTargetPhrase(auth, Features.menuVariantsModifiers)}. '
              'Upgrade to manage them.'
          : 'Couldn\'t load modifier groups: ${e.message}');
    } catch (e) {
      setState(() => _error = 'Couldn\'t load modifier groups: $e');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _openEdit(Map<String, dynamic>? group) async {
    final changed = await Navigator.push<bool>(context, MaterialPageRoute(
      builder: (_) => _ModifierGroupEditScreen(group: group),
    ));
    if (changed == true) await _load();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        leading: (ModalRoute.of(context)?.isFirst ?? true) ? const HomeDrawerButton() : null,
        title: const Text('Modifier groups'),
        actions: [
          IconButton(
            icon: const Icon(Icons.add),
            onPressed: () => _openEdit(null),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : _error != null
                ? _errorState()
                : _groups.isEmpty
                    ? _emptyState()
                    : ListView.separated(
                        itemCount: _groups.length,
                        separatorBuilder: (_, __) => const Divider(height: 1),
                        itemBuilder: (_, i) => _row(_groups[i]),
                      ),
      ),
    bottomNavigationBar: const HomeBottomNav(),
    );
  }

  // List physics must scroll even when empty for RefreshIndicator to work.
  Widget _emptyState() => ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: const [
          SizedBox(height: 80),
          Icon(Icons.tune, size: 56, color: AppColors.textHint),
          SizedBox(height: 12),
          Center(
            child: Text(
              'No modifier groups yet',
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800),
            ),
          ),
          SizedBox(height: 6),
          Padding(
            padding: EdgeInsets.symmetric(horizontal: 40),
            child: Text(
              'Tap + to create one (e.g. "Spice level", "Toppings"). '
              'Once a group exists, you can attach it to any menu item.',
              textAlign: TextAlign.center,
              style: TextStyle(color: AppColors.textSecondary, fontSize: 12),
            ),
          ),
        ],
      );

  Widget _errorState() => ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          const SizedBox(height: 80),
          const Icon(Icons.lock_outline, size: 56, color: AppColors.textHint),
          const SizedBox(height: 12),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 32),
            child: Text(_error ?? 'Unknown error',
                textAlign: TextAlign.center,
                style: const TextStyle(
                    color: AppColors.textSecondary, fontSize: 13)),
          ),
        ],
      );

  Widget _row(Map<String, dynamic> g) {
    final kind = g['kind'] as String? ?? 'single_select';
    final min = (g['minSelect'] as num?)?.toInt() ?? 0;
    final max = (g['maxSelect'] as num?)?.toInt() ?? 1;
    final mods = (g['modifiers'] as List?) ?? const [];
    final isActive = g['isActive'] as bool? ?? true;

    return ListTile(
      leading: CircleAvatar(
        backgroundColor: kind == 'multi_select'
            ? AppColors.warning.withValues(alpha: 0.15)
            : AppColors.primary.withValues(alpha: 0.15),
        child: Icon(
          kind == 'multi_select' ? Icons.check_box_outlined : Icons.radio_button_checked,
          color: kind == 'multi_select' ? AppColors.warning : AppColors.primary,
          size: 20,
        ),
      ),
      title: Text(
        (g['name'] ?? 'Untitled') as String,
        style: TextStyle(
          fontWeight: FontWeight.w800,
          color: isActive ? null : AppColors.textHint,
          decoration: isActive ? null : TextDecoration.lineThrough,
        ),
      ),
      subtitle: Text(
        '${kind == 'single_select' ? 'pick 1' : 'multi'} '
        '($min–$max) · ${mods.length} option${mods.length == 1 ? '' : 's'}',
        style: const TextStyle(fontSize: 12, color: AppColors.textSecondary),
      ),
      trailing: const Icon(Icons.chevron_right),
      onTap: () => _openEdit(g),
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────
//                          EDIT / CREATE SCREEN
// ──────────────────────────────────────────────────────────────────────────

class _ModifierGroupEditScreen extends StatefulWidget {
  final Map<String, dynamic>? group;
  const _ModifierGroupEditScreen({this.group});

  @override
  State<_ModifierGroupEditScreen> createState() =>
      _ModifierGroupEditScreenState();
}

class _ModifierGroupEditScreenState extends State<_ModifierGroupEditScreen> {
  late final TextEditingController _name;
  late String _kind;
  late final TextEditingController _minSel;
  late final TextEditingController _maxSel;
  late bool _isActive;
  final List<_ModDraft> _modifiers = [];
  bool _saving = false;

  bool get _isCreate => widget.group == null;

  @override
  void initState() {
    super.initState();
    final g = widget.group;
    _name = TextEditingController(text: g?['name']?.toString() ?? '');
    _kind = (g?['kind'] as String?) ?? 'single_select';
    _minSel = TextEditingController(
        text: ((g?['minSelect'] as num?)?.toInt() ?? 0).toString());
    _maxSel = TextEditingController(
        text: ((g?['maxSelect'] as num?)?.toInt() ?? 1).toString());
    _isActive = g?['isActive'] as bool? ?? true;
    final mods = (g?['modifiers'] as List?) ?? const [];
    _modifiers.addAll(mods.map((m) => _ModDraft.fromJson(m as Map)));
  }

  @override
  void dispose() {
    _name.dispose(); _minSel.dispose(); _maxSel.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_name.text.trim().isEmpty) {
      _toast('Name is required');
      return;
    }
    final minSel = int.tryParse(_minSel.text) ?? 0;
    final maxSel = int.tryParse(_maxSel.text) ?? 1;
    if (maxSel < minSel) {
      _toast('Max must be ≥ min');
      return;
    }
    // Catch the common single_select misconfig early — backend doesn't
    // enforce this, but it's confusing UX if a "pick 1" group lets the
    // customer pick 3.
    if (_kind == 'single_select' && maxSel > 1) {
      _toast('Single-select groups can have max 1 pick');
      return;
    }
    // Filter empty rows the user added but never filled in.
    final cleanMods = _modifiers
        .where((m) => m.name.trim().isNotEmpty)
        .toList();
    if (cleanMods.isEmpty) {
      _toast('Add at least one modifier option');
      return;
    }

    setState(() => _saving = true);
    final auth = context.read<AuthProvider>();
    final biz = auth.business!;
    final body = <String, dynamic>{
      if (widget.group?['id'] != null) 'id': widget.group!['id'],
      'name': _name.text.trim(),
      'kind': _kind,
      'minSelect': minSel,
      'maxSelect': maxSel,
      'isActive': _isActive,
      'modifiers': cleanMods.map((m) => m.toJson()).toList(),
    };
    try {
      await ApiService.instance.upsertModifierGroup(biz.id, body);
      if (!mounted) return;
      Navigator.pop(context, true);
    } on ApiException catch (e) {
      // `auth` was captured before the await on purpose — reading a provider
      // off `context` after an async gap is exactly what
      // use_build_context_synchronously warns about, and CI fails on warnings.
      _toast(e.statusCode == 402
          ? 'Managing modifier groups needs '
              '${upgradeTargetPhrase(auth, Features.menuVariantsModifiers)}'
          : 'Save failed: ${e.message}');
    } catch (e) {
      _toast('Save failed: $e');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  void _toast(String msg) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        leading: (ModalRoute.of(context)?.isFirst ?? true) ? const HomeDrawerButton() : null,
        
        title: Text(_isCreate ? 'New modifier group' : 'Edit group'),
        actions: [
          TextButton(
            onPressed: _saving ? null : _save,
            child: const Text('Save',
                style: TextStyle(fontWeight: FontWeight.w800)),
          ),
        ],
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            // ── Basics ────────────────────────────────────────────────────
            _section('Basics'),
            TextField(
              controller: _name,
              textCapitalization: TextCapitalization.words,
              decoration: const InputDecoration(
                labelText: 'Group name *',
                border: OutlineInputBorder(),
                hintText: 'Spice level, Toppings, Extras…',
              ),
            ),
            const SizedBox(height: 12),
            // Kind picker — segmented buttons keep the choice obvious.
            const Text('Selection type',
                style: TextStyle(fontWeight: FontWeight.w700, fontSize: 13)),
            const SizedBox(height: 6),
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(
                  value: 'single_select',
                  label: Text('Pick 1'),
                  icon: Icon(Icons.radio_button_checked, size: 16),
                ),
                ButtonSegment(
                  value: 'multi_select',
                  label: Text('Pick many'),
                  icon: Icon(Icons.check_box_outlined, size: 16),
                ),
              ],
              selected: {_kind},
              onSelectionChanged: (s) {
                setState(() {
                  _kind = s.first;
                  // Snap maxSelect down to 1 when flipping to single_select,
                  // matching the validation we enforce on save.
                  if (_kind == 'single_select') {
                    final cur = int.tryParse(_maxSel.text) ?? 1;
                    if (cur > 1) _maxSel.text = '1';
                  }
                });
              },
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _minSel,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(
                      labelText: 'Min picks',
                      border: OutlineInputBorder(),
                      helperText: '0 = optional',
                    ),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: TextField(
                    controller: _maxSel,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(
                      labelText: 'Max picks',
                      border: OutlineInputBorder(),
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            SwitchListTile(
              title: const Text('Active'),
              subtitle: const Text(
                  'Inactive groups stay attached but won\'t show at order time'),
              value: _isActive,
              onChanged: (v) => setState(() => _isActive = v),
              contentPadding: EdgeInsets.zero,
            ),
            const SizedBox(height: 8),

            // ── Modifiers ─────────────────────────────────────────────────
            _section('Options'),
            ...List.generate(_modifiers.length, (i) => _modRow(i)),
            const SizedBox(height: 6),
            OutlinedButton.icon(
              icon: const Icon(Icons.add, size: 16),
              label: const Text('Add option'),
              onPressed: () => setState(() => _modifiers.add(_ModDraft())),
            ),
            const SizedBox(height: 24),

            // ── Big save (mirror the AppBar Save for fat thumbs) ──────────
            SizedBox(
              width: double.infinity,
              height: 52,
              child: ElevatedButton(
                onPressed: _saving ? null : _save,
                child: _saving
                    ? const SizedBox(
                        height: 22,
                        width: 22,
                        child: CircularProgressIndicator(
                            strokeWidth: 2.4, color: Colors.white))
                    : Text(_isCreate ? 'Create group' : 'Save changes',
                        style: const TextStyle(
                            fontWeight: FontWeight.w900, fontSize: 16)),
              ),
            ),
          ],
        ),
      ),
      bottomNavigationBar: const HomeBottomNav(),
    );
  }

  Widget _modRow(int i) {
    final m = _modifiers[i];
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          Expanded(
            flex: 3,
            child: TextFormField(
              initialValue: m.name,
              decoration: const InputDecoration(
                labelText: 'Option name',
                isDense: true,
                border: OutlineInputBorder(),
                hintText: 'Mild, Hot…',
              ),
              onChanged: (t) => m.name = t,
            ),
          ),
          const SizedBox(width: 6),
          Expanded(
            flex: 2,
            child: TextFormField(
              initialValue: m.priceDelta.toString(),
              keyboardType: const TextInputType.numberWithOptions(
                  decimal: true, signed: true),
              decoration: const InputDecoration(
                labelText: 'Δ Price ₹',
                isDense: true,
                border: OutlineInputBorder(),
                helperText: '0 if free',
              ),
              onChanged: (t) => m.priceDelta = double.tryParse(t) ?? 0,
            ),
          ),
          IconButton(
            icon: const Icon(Icons.delete_outline, size: 20),
            color: AppColors.error,
            onPressed: () => setState(() => _modifiers.removeAt(i)),
          ),
        ],
      ),
    );
  }

  Widget _section(String label) => Padding(
        padding: const EdgeInsets.only(bottom: 8, top: 4),
        child: Text(label.toUpperCase(),
            style: const TextStyle(
                color: AppColors.textSecondary,
                fontSize: 11,
                fontWeight: FontWeight.w900,
                letterSpacing: 1.2)),
      );
}

// Local draft model for a modifier option. We hold IDs so the backend can
// update existing options in-place (preserving FKs).
class _ModDraft {
  String? id;
  String name;
  double priceDelta;

  _ModDraft({this.id, this.name = '', this.priceDelta = 0});

  factory _ModDraft.fromJson(Map m) => _ModDraft(
        id: m['id']?.toString(),
        name: m['name']?.toString() ?? '',
        priceDelta: (m['priceDeltaInr'] as num?)?.toDouble() ?? 0,
      );

  Map<String, dynamic> toJson() => {
        if (id != null) 'id': id,
        'name': name.trim(),
        'priceDeltaInr': priceDelta,
      };
}
