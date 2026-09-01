// NamastePOS — mobile floor & table editor.
//
// Owner asked: "can't edit floor names and also can't arrange tables from
// mobile app". Backend has full CRUD (POST/PUT/DELETE on
// /businesses/:id/ops/floors and /ops/tables) — this screen wires it up
// on mobile so the owner doesn't need the dashboard just to rename
// "Ground floor1" to "First floor" or add a new table.
//
// UX:
//   * Header shows floor list with rename / delete / +Add.
//   * Body shows the selected floor's tables. Each row: edit-icon
//     (label + seats + shape + service-mode), delete-icon.
//   * FAB adds a table to the currently selected floor.
//   * Refresh pulls fresh data and repopulates TablesProvider so
//     the Captain/Tables tab picks up the change immediately.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../providers/auth_provider.dart';
import '../../providers/tables_provider.dart';
import '../../services/api_service.dart';
import '../../utils/error_humanizer.dart';
import '../../widgets/home_bottom_nav.dart';
import '../../widgets/home_drawer_button.dart';

class TablesEditorScreen extends StatefulWidget {
  const TablesEditorScreen({super.key});

  @override
  State<TablesEditorScreen> createState() => _TablesEditorScreenState();
}

class _TablesEditorScreenState extends State<TablesEditorScreen> {
  List<Map<String, dynamic>> _floors = [];
  List<Map<String, dynamic>> _tables = [];
  String? _selectedFloorId;
  bool _loading = true;
  String? _error;
  // Toggle between the list view (add/rename/delete in a linear list)
  // and the arrange canvas (drag tables around a floor plan). Canvas
  // is the default so first paint matches the dashboard behaviour the
  // owner expects.
  bool _canvasMode = true;
  // In-flight saves for x/y drag persistence — keyed by table id so
  // consecutive drags on the same table don't spam the backend.
  final Set<String> _savingPos = {};

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final biz = context.read<AuthProvider>().business;
    if (biz == null) return;
    setState(() { _loading = true; _error = null; });
    try {
      final floors = (await ApiService.instance.listFloors(biz.id))
          .cast<Map>().map((m) => m.cast<String, dynamic>()).toList();
      final tables = (await ApiService.instance.listOpsTables(biz.id))
          .cast<Map>().map((m) => m.cast<String, dynamic>()).toList();
      if (!mounted) return; // H6 (2026-08-23)
      setState(() {
        _floors = floors;
        _tables = tables;
        // Keep the previously selected floor if it still exists;
        // otherwise fall back to the first one.
        if (_selectedFloorId == null ||
            !floors.any((f) => f['id'] == _selectedFloorId)) {
          _selectedFloorId = floors.isNotEmpty
              ? floors.first['id'] as String?
              : null;
        }
        _loading = false;
      });
      // Refresh the shared TablesProvider so Captain / POS pick up
      // the change without needing a full re-login.
      if (mounted) {
        // ignore: use_build_context_synchronously
        await context.read<TablesProvider>().refresh();
      }
    } catch (e) {
      if (!mounted) return;
      setState(() { _error = humanizeError(e); _loading = false; });
    }
  }

  String? get _bizId => context.read<AuthProvider>().business?.id;

  Future<void> _addFloor() async {
    final name = await _promptText(
      title: 'Add floor',
      hint: 'e.g. First floor',
    );
    if (name == null || name.isEmpty) return;
    final biz = _bizId; if (biz == null) return;
    try {
      final floor = await ApiService.instance.createFloor(biz, {'name': name});
      if (!mounted) return; // FB-20: guard setState after await
      setState(() {
        _floors = [..._floors, floor];
        _selectedFloorId = floor['id'] as String?;
      });
      await _load();
    } catch (e) {
      _err('Could not add floor: ${humanizeError(e)}');
    }
  }

  Future<void> _renameFloor(Map<String, dynamic> floor) async {
    final name = await _promptText(
      title: 'Rename floor',
      hint: 'New name',
      initial: floor['name']?.toString() ?? '',
    );
    if (name == null || name.isEmpty) return;
    final biz = _bizId; if (biz == null) return;
    try {
      await ApiService.instance.updateFloor(biz, floor['id'] as String, {'name': name});
      await _load();
    } catch (e) {
      _err('Could not rename: ${humanizeError(e)}');
    }
  }

  Future<void> _deleteFloor(Map<String, dynamic> floor) async {
    final tablesOnFloor = _tables.where((t) =>
        t['floor_id'] == floor['id'] || t['floorId'] == floor['id']).length;
    final ok = await _confirm(
      title: 'Delete floor "${floor['name']}"?',
      body: tablesOnFloor > 0
          ? 'This floor has $tablesOnFloor table(s). Delete them first or move them.'
          : 'The floor will be removed. This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
      // Backend enforces "no tables" — disable the confirm button too.
      canConfirm: tablesOnFloor == 0,
    );
    if (ok != true) return;
    final biz = _bizId; if (biz == null) return;
    try {
      await ApiService.instance.deleteFloor(biz, floor['id'] as String);
      if (_selectedFloorId == floor['id']) _selectedFloorId = null;
      await _load();
    } catch (e) {
      _err('Could not delete floor: ${humanizeError(e)}');
    }
  }

  Future<void> _addTable() async {
    final floorId = _selectedFloorId;
    if (floorId == null) {
      _err('Add a floor first.');
      return;
    }
    final draft = await showDialog<_TableDraft>(
      context: context,
      builder: (_) => _TableFormDialog(
        title: 'Add table',
        floors: _floors,
        initialFloorId: floorId,
      ),
    );
    if (draft == null) return;
    final biz = _bizId; if (biz == null) return;
    try {
      await ApiService.instance.createOpsTable(biz, draft.toCreateBody());
      await _load();
    } catch (e) {
      _err('Could not add table: ${humanizeError(e)}');
    }
  }

  Future<void> _editTable(Map<String, dynamic> table) async {
    final draft = await showDialog<_TableDraft>(
      context: context,
      builder: (_) => _TableFormDialog(
        title: 'Edit table',
        floors: _floors,
        initialFloorId: (table['floor_id'] ?? table['floorId']) as String?,
        initialLabel: table['label']?.toString(),
        initialSeats: (table['seats'] as num?)?.toInt(),
        initialShape: table['shape']?.toString(),
        initialServiceMode: table['service_mode']?.toString()
            ?? table['serviceMode']?.toString(),
      ),
    );
    if (draft == null) return;
    final biz = _bizId; if (biz == null) return;
    try {
      await ApiService.instance.updateOpsTable(
        biz, table['id'] as String, draft.toPatchBody(),
      );
      await _load();
    } catch (e) {
      _err('Could not save table: ${humanizeError(e)}');
    }
  }

  Future<void> _deleteTable(Map<String, dynamic> table) async {
    final ok = await _confirm(
      title: 'Delete table "${table['label']}"?',
      body: 'Any active session on this table must be closed first.',
      confirmLabel: 'Delete',
      destructive: true,
    );
    if (ok != true) return;
    final biz = _bizId; if (biz == null) return;
    try {
      await ApiService.instance.deleteOpsTable(biz, table['id'] as String);
      await _load();
    } catch (e) {
      _err('Could not delete table: ${humanizeError(e)}');
    }
  }

  Future<String?> _promptText({
    required String title,
    String? hint,
    String initial = '',
  }) async {
    final ctl = TextEditingController(text: initial);
    return showDialog<String>(
      context: context,
      builder: (_) => AlertDialog(
        title: Text(title),
        content: TextField(
          controller: ctl,
          autofocus: true,
          decoration: InputDecoration(hintText: hint),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
          ElevatedButton(
            onPressed: () => Navigator.pop(context, ctl.text.trim()),
            child: const Text('Save'),
          ),
        ],
      ),
    );
  }

  Future<bool?> _confirm({
    required String title,
    required String body,
    required String confirmLabel,
    bool destructive = false,
    bool canConfirm = true,
  }) async {
    return showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: Text(title),
        content: Text(body),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel')),
          ElevatedButton(
            onPressed: canConfirm ? () => Navigator.pop(context, true) : null,
            style: destructive
                ? ElevatedButton.styleFrom(backgroundColor: AppColors.error)
                : null,
            child: Text(confirmLabel),
          ),
        ],
      ),
    );
  }

  void _err(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(msg),
      backgroundColor: AppColors.error,
    ));
  }

  @override
  Widget build(BuildContext context) {
    final tablesOnFloor = _tables.where((t) =>
      t['floor_id'] == _selectedFloorId || t['floorId'] == _selectedFloorId
    ).toList();

    return Scaffold(
      appBar: AppBar(
        leading: (ModalRoute.of(context)?.isFirst ?? true) ? const HomeDrawerButton() : null,
        title: const Text('Floors & tables'),
        actions: [
          // Toggle between canvas (drag arrange) and list (linear edit).
          IconButton(
            icon: Icon(_canvasMode
                ? Icons.list_alt_rounded
                : Icons.dashboard_customize_outlined),
            tooltip: _canvasMode ? 'List view' : 'Arrange (canvas)',
            onPressed: () => setState(() => _canvasMode = !_canvasMode),
          ),
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: _loading ? null : _load,
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? _ErrorBox(error: _error!, onRetry: _load)
              : RefreshIndicator(
                  onRefresh: _load,
                  child: ListView(
                    padding: const EdgeInsets.only(bottom: 96),
                    children: [
                      _FloorsCard(
                        floors: _floors,
                        selectedFloorId: _selectedFloorId,
                        onSelect: (id) => setState(() => _selectedFloorId = id),
                        onRename: _renameFloor,
                        onDelete: _deleteFloor,
                        onAdd: _addFloor,
                      ),
                      const SizedBox(height: 8),
                      Padding(
                        padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
                        child: Row(
                          children: [
                            const Text('Tables',
                                style: TextStyle(fontWeight: FontWeight.w800,
                                    fontSize: 16)),
                            const Spacer(),
                            Text('${tablesOnFloor.length} on this floor',
                                style: const TextStyle(
                                  fontSize: 12,
                                  color: AppColors.textSecondary,
                                )),
                          ],
                        ),
                      ),
                      if (_selectedFloorId == null)
                        const Padding(
                          padding: EdgeInsets.all(24),
                          child: Text(
                            'Add a floor first — every table has to sit on one.',
                            textAlign: TextAlign.center,
                            style: TextStyle(color: AppColors.textSecondary),
                          ),
                        )
                      else if (tablesOnFloor.isEmpty)
                        const Padding(
                          padding: EdgeInsets.all(24),
                          child: Text(
                            'No tables yet. Use the + button to add one.',
                            textAlign: TextAlign.center,
                            style: TextStyle(color: AppColors.textSecondary),
                          ),
                        )
                      else if (_canvasMode)
                        Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 16),
                          child: _FloorCanvas(
                            tables: tablesOnFloor,
                            savingIds: _savingPos,
                            onDragEnd: (table, newX, newY) async {
                              // Optimistically update local state so the
                              // tile stays where the user dropped it while
                              // the PUT is in-flight.
                              final id = table['id'] as String;
                              setState(() {
                                for (final t in _tables) {
                                  if (t['id'] == id) {
                                    t['x_pos'] = newX;
                                    t['y_pos'] = newY;
                                    t['xPos'] = newX;
                                    t['yPos'] = newY;
                                  }
                                }
                                _savingPos.add(id);
                              });
                              final biz = _bizId;
                              if (biz == null) return;
                              try {
                                await ApiService.instance.updateOpsTable(
                                  biz, id,
                                  {'xPos': newX, 'yPos': newY},
                                );
                              } catch (e) {
                                _err('Could not save table position: ${humanizeError(e)}');
                                // Refresh from backend to correct the mismatch
                                await _load();
                              } finally {
                                if (mounted) {
                                  setState(() => _savingPos.remove(id));
                                }
                              }
                            },
                            onTap: (t) => _editTable(t),
                          ),
                        )
                      else
                        ...tablesOnFloor.map((t) => _TableRow(
                              table: t,
                              onEdit: () => _editTable(t),
                              onDelete: () => _deleteTable(t),
                            )),
                    ],
                  ),
                ),
      floatingActionButton: _selectedFloorId == null
          ? null
          : FloatingActionButton.extended(
              onPressed: _addTable,
              icon: const Icon(Icons.add),
              label: const Text('Add table'),
            ),
      bottomNavigationBar: const HomeBottomNav(),
    );
  }
}

class _FloorsCard extends StatelessWidget {
  final List<Map<String, dynamic>> floors;
  final String? selectedFloorId;
  final ValueChanged<String> onSelect;
  final ValueChanged<Map<String, dynamic>> onRename;
  final ValueChanged<Map<String, dynamic>> onDelete;
  final VoidCallback onAdd;

  const _FloorsCard({
    required this.floors,
    required this.selectedFloorId,
    required this.onSelect,
    required this.onRename,
    required this.onDelete,
    required this.onAdd,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 16, 16, 0),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppColors.surface,
        border: Border.all(color: AppColors.divider),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Text('Floors',
                  style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
              const Spacer(),
              TextButton.icon(
                icon: const Icon(Icons.add, size: 18),
                label: const Text('Add floor'),
                onPressed: onAdd,
              ),
            ],
          ),
          if (floors.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 12),
              child: Text('No floors yet — tap "Add floor".',
                  style: TextStyle(color: AppColors.textSecondary)),
            )
          else
            ...floors.map((f) {
              final selected = f['id'] == selectedFloorId;
              return Container(
                margin: const EdgeInsets.only(top: 8),
                decoration: BoxDecoration(
                  color: selected
                      ? AppColors.primary.withValues(alpha: 0.08)
                      : Colors.transparent,
                  border: Border.all(
                    color: selected ? AppColors.primary : AppColors.divider,
                  ),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: ListTile(
                  onTap: () => onSelect(f['id'] as String),
                  title: Text(f['name']?.toString() ?? '(unnamed)',
                      style: TextStyle(
                          fontWeight: selected
                              ? FontWeight.w800
                              : FontWeight.w500)),
                  trailing: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      IconButton(
                        icon: const Icon(Icons.edit_outlined, size: 20),
                        tooltip: 'Rename',
                        onPressed: () => onRename(f),
                      ),
                      IconButton(
                        icon: const Icon(Icons.delete_outline,
                            size: 20, color: AppColors.error),
                        tooltip: 'Delete',
                        onPressed: () => onDelete(f),
                      ),
                    ],
                  ),
                ),
              );
            }),
        ],
      ),
    );
  }
}

class _TableRow extends StatelessWidget {
  final Map<String, dynamic> table;
  final VoidCallback onEdit;
  final VoidCallback onDelete;
  const _TableRow({
    required this.table,
    required this.onEdit,
    required this.onDelete,
  });

  @override
  Widget build(BuildContext context) {
    final label = table['label']?.toString() ?? '(no label)';
    final seats = (table['seats'] as num?)?.toInt() ?? 0;
    final shape = table['shape']?.toString() ?? 'square';
    final status = table['status']?.toString() ?? 'available';
    final serviceMode = (table['service_mode'] ?? table['serviceMode'])?.toString();

    return Container(
      margin: const EdgeInsets.fromLTRB(16, 6, 16, 0),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppColors.surface,
        border: Border.all(color: AppColors.divider),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        children: [
          Container(
            width: 44, height: 44,
            decoration: BoxDecoration(
              color: AppColors.primary.withValues(alpha: 0.10),
              borderRadius: BorderRadius.circular(8),
            ),
            alignment: Alignment.center,
            child: Text(label,
                style: const TextStyle(
                    fontWeight: FontWeight.w900, color: AppColors.primary)),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Table $label',
                    style: const TextStyle(fontWeight: FontWeight.w700)),
                const SizedBox(height: 2),
                Text(
                  '$seats seats · $shape · $status'
                  '${serviceMode != null ? " · $serviceMode" : ""}',
                  style: const TextStyle(
                      fontSize: 12, color: AppColors.textSecondary),
                ),
              ],
            ),
          ),
          IconButton(
            icon: const Icon(Icons.edit_outlined),
            tooltip: 'Edit',
            onPressed: onEdit,
          ),
          IconButton(
            icon: const Icon(Icons.delete_outline, color: AppColors.error),
            tooltip: 'Delete',
            onPressed: onDelete,
          ),
        ],
      ),
    );
  }
}

class _ErrorBox extends StatelessWidget {
  final String error;
  final VoidCallback onRetry;
  const _ErrorBox({required this.error, required this.onRetry});
  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Icon(Icons.error_outline, color: AppColors.error, size: 40),
              const SizedBox(height: 12),
              Text(error, textAlign: TextAlign.center),
              const SizedBox(height: 12),
              ElevatedButton(onPressed: onRetry, child: const Text('Retry')),
            ],
          ),
        ),
      );
}

// ── Add / edit dialog ────────────────────────────────────────────────────

class _TableDraft {
  final String? floorId;
  final String label;
  final int seats;
  final String shape;
  final String? serviceMode;
  const _TableDraft({
    required this.floorId,
    required this.label,
    required this.seats,
    required this.shape,
    required this.serviceMode,
  });

  Map<String, dynamic> toCreateBody() => {
        'floorId': floorId,
        'label': label,
        'seats': seats,
        'shape': shape,
        if (serviceMode != null) 'serviceMode': serviceMode,
      };

  Map<String, dynamic> toPatchBody() => {
        if (floorId != null) 'floorId': floorId,
        'label': label,
        'seats': seats,
        'shape': shape,
        // Explicit null on serviceMode means "inherit from business".
        'serviceMode': serviceMode,
      };
}

class _TableFormDialog extends StatefulWidget {
  final String title;
  final List<Map<String, dynamic>> floors;
  final String? initialFloorId;
  final String? initialLabel;
  final int? initialSeats;
  final String? initialShape;
  final String? initialServiceMode;
  const _TableFormDialog({
    required this.title,
    required this.floors,
    this.initialFloorId,
    this.initialLabel,
    this.initialSeats,
    this.initialShape,
    this.initialServiceMode,
  });

  @override
  State<_TableFormDialog> createState() => _TableFormDialogState();
}

class _TableFormDialogState extends State<_TableFormDialog> {
  late TextEditingController _label;
  late TextEditingController _seats;
  String? _floorId;
  String _shape = 'square';
  String _serviceMode = 'inherit';

  @override
  void initState() {
    super.initState();
    _label = TextEditingController(text: widget.initialLabel ?? '');
    _seats = TextEditingController(
        text: (widget.initialSeats ?? 4).toString());
    _floorId = widget.initialFloorId;
    _shape = widget.initialShape ?? 'square';
    _serviceMode = widget.initialServiceMode ?? 'inherit';
  }

  @override
  void dispose() {
    _label.dispose();
    _seats.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(widget.title),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            DropdownButtonFormField<String>(
              value: _floorId,
              decoration: const InputDecoration(labelText: 'Floor'),
              items: widget.floors.map((f) => DropdownMenuItem(
                value: f['id'] as String,
                child: Text(f['name']?.toString() ?? '(unnamed)'),
              )).toList(),
              onChanged: (v) => setState(() => _floorId = v),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _label,
              decoration: const InputDecoration(labelText: 'Label (e.g. 1, A1, VIP)'),
              autofocus: widget.initialLabel == null,
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _seats,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'Seats'),
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              value: _shape,
              decoration: const InputDecoration(labelText: 'Shape'),
              items: const [
                DropdownMenuItem(value: 'square', child: Text('Square')),
                DropdownMenuItem(value: 'round', child: Text('Round')),
                DropdownMenuItem(value: 'rectangle', child: Text('Rectangle')),
                DropdownMenuItem(value: 'booth', child: Text('Booth')),
              ],
              onChanged: (v) => setState(() => _shape = v ?? 'square'),
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              value: _serviceMode,
              decoration: const InputDecoration(labelText: 'Service mode'),
              items: const [
                DropdownMenuItem(value: 'inherit', child: Text('Inherit from business')),
                DropdownMenuItem(value: 'dine_in',    child: Text('Dine-in (waiter)')),
                DropdownMenuItem(value: 'self_pickup', child: Text('Self-pickup')),
              ],
              onChanged: (v) => setState(() => _serviceMode = v ?? 'inherit'),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        ElevatedButton(
          onPressed: () {
            final label = _label.text.trim();
            final seats = int.tryParse(_seats.text.trim()) ?? 4;
            if (label.isEmpty || _floorId == null) return;
            Navigator.pop(context, _TableDraft(
              floorId: _floorId,
              label: label,
              seats: seats,
              shape: _shape,
              serviceMode: _serviceMode == 'inherit' ? null : _serviceMode,
            ));
          },
          child: const Text('Save'),
        ),
      ],
    );
  }
}

// ── Drag-to-arrange canvas ───────────────────────────────────────────────
//
// Each table renders as an absolutely-positioned 84×84 tile inside a
// fixed-height canvas (600 px). Owner drags a tile with a pan gesture;
// on release we clamp inside the canvas and fire onDragEnd(x, y).
// Callers are expected to PUT the new position to
// /ops/tables/:id?xPos&yPos and refresh local state.
//
// The canvas uses the same coordinate space as the dashboard's
// FloorCanvas — plain pixel offsets from the top-left. Because phone
// screens are narrower than the dashboard canvas, we clamp on Save
// AND on load so no tile can be dragged off-screen.

class _FloorCanvas extends StatelessWidget {
  final List<Map<String, dynamic>> tables;
  final Set<String> savingIds;
  final void Function(Map<String, dynamic> table, int x, int y) onDragEnd;
  final void Function(Map<String, dynamic> table) onTap;
  const _FloorCanvas({
    required this.tables,
    required this.savingIds,
    required this.onDragEnd,
    required this.onTap,
  });

  static const double _canvasHeight = 600;
  static const double _tileSize = 84;
  static const double _gap = 16;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, cts) {
      final canvasWidth = cts.maxWidth;
      // Owner asked: "if owner does not arrange the layout of tables
      // in floor, they should be in sequence one by one by default"
      // — tables were stacking at (0,0) because we defaulted xPos/yPos
      // to 0 on create. When a table has no saved position, place it
      // in a grid slot based on its index in the un-positioned list.
      final positioned = _autoPosition(tables, canvasWidth);
      return Container(
        height: _canvasHeight,
        decoration: BoxDecoration(
          color: AppColors.surface,
          border: Border.all(color: AppColors.divider),
          borderRadius: BorderRadius.circular(12),
        ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(12),
          child: Stack(
            children: [
              // Grid overlay
              CustomPaint(
                size: Size(canvasWidth, _canvasHeight),
                painter: _GridPainter(),
              ),
              // Instructional overlay: show once, when we know the
              // canvas is in the auto-arranged fallback (all zero
              // positions in the DB — i.e. never dragged).
              if (tables.every((t) =>
                  ((t['x_pos'] ?? t['xPos'] ?? 0) as num) == 0 &&
                  ((t['y_pos'] ?? t['yPos'] ?? 0) as num) == 0))
                const Positioned(
                  top: 12, left: 0, right: 0,
                  child: Center(
                    child: Padding(
                      padding: EdgeInsets.symmetric(horizontal: 20),
                      child: Text(
                        'Drag tables to arrange your floor. Tap a tile to edit it.',
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          fontSize: 12, color: AppColors.textSecondary,
                        ),
                      ),
                    ),
                  ),
                ),
              // The tiles
              for (final entry in positioned)
                _DraggableTable(
                  table: entry.$1,
                  autoX: entry.$2,
                  autoY: entry.$3,
                  saving: savingIds.contains(entry.$1['id']),
                  canvasWidth: canvasWidth,
                  canvasHeight: _canvasHeight,
                  tileSize: _tileSize,
                  onDragEnd: onDragEnd,
                  onTap: () => onTap(entry.$1),
                ),
            ],
          ),
        ),
      );
    });
  }

  /// Compute an auto grid position for every table that hasn't been
  /// dragged (both x=0 and y=0). Tables that already have coords keep
  /// them. Returns a list of (table, effectiveX, effectiveY) triples.
  List<(Map<String, dynamic>, double, double)> _autoPosition(
      List<Map<String, dynamic>> src, double canvasWidth) {
    // Header area we don't want to cover in the fallback banner.
    const topOffset = 44.0;
    final cols = ((canvasWidth - _gap) ~/ (_tileSize + _gap)).clamp(1, 6);
    // First pass: partition unpositioned vs positioned.
    final unpositioned = <Map<String, dynamic>>[];
    for (final t in src) {
      final x = ((t['x_pos'] ?? t['xPos'] ?? 0) as num).toDouble();
      final y = ((t['y_pos'] ?? t['yPos'] ?? 0) as num).toDouble();
      if (x == 0 && y == 0) unpositioned.add(t);
    }
    // Sort unpositioned by label so grid order stays stable between
    // paints (otherwise a re-fetch could reshuffle).
    unpositioned.sort((a, b) =>
        (a['label']?.toString() ?? '').compareTo(b['label']?.toString() ?? ''));
    // Map each unpositioned to its slot.
    final slotByTableId = <String, (double, double)>{};
    for (var i = 0; i < unpositioned.length; i++) {
      final col = i % cols;
      final row = i ~/ cols;
      final x = _gap + col * (_tileSize + _gap);
      final y = topOffset + row * (_tileSize + _gap);
      slotByTableId[unpositioned[i]['id'] as String] = (x, y);
    }
    // Build result preserving original order.
    final out = <(Map<String, dynamic>, double, double)>[];
    for (final t in src) {
      final x = ((t['x_pos'] ?? t['xPos'] ?? 0) as num).toDouble();
      final y = ((t['y_pos'] ?? t['yPos'] ?? 0) as num).toDouble();
      if (x == 0 && y == 0) {
        final slot = slotByTableId[t['id']];
        if (slot != null) {
          out.add((t, slot.$1, slot.$2));
          continue;
        }
      }
      out.add((t, x, y));
    }
    return out;
  }
}

class _GridPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = AppColors.divider.withValues(alpha: 0.5)
      ..strokeWidth = 0.5;
    const step = 40.0;
    for (double x = 0; x < size.width; x += step) {
      canvas.drawLine(Offset(x, 0), Offset(x, size.height), paint);
    }
    for (double y = 0; y < size.height; y += step) {
      canvas.drawLine(Offset(0, y), Offset(size.width, y), paint);
    }
  }
  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

class _DraggableTable extends StatefulWidget {
  final Map<String, dynamic> table;
  /// When the table hasn't been dragged (x=0, y=0), the canvas assigns
  /// a grid slot so tiles don't stack on top of each other. Passed in
  /// so drag deltas start from the visible position, not (0,0).
  final double autoX;
  final double autoY;
  final bool saving;
  final double canvasWidth;
  final double canvasHeight;
  final double tileSize;
  final void Function(Map<String, dynamic>, int, int) onDragEnd;
  final VoidCallback onTap;

  const _DraggableTable({
    required this.table,
    required this.autoX,
    required this.autoY,
    required this.saving,
    required this.canvasWidth,
    required this.canvasHeight,
    required this.tileSize,
    required this.onDragEnd,
    required this.onTap,
  });

  @override
  State<_DraggableTable> createState() => _DraggableTableState();
}

class _DraggableTableState extends State<_DraggableTable> {
  double? _dragX;
  double? _dragY;
  bool _dragging = false;

  double _clampX(double x) =>
      x.clamp(0.0, widget.canvasWidth - widget.tileSize).toDouble();
  double _clampY(double y) =>
      y.clamp(0.0, widget.canvasHeight - widget.tileSize).toDouble();

  double get _baseX {
    final x = ((widget.table['x_pos'] ?? widget.table['xPos'] ?? 0) as num).toDouble();
    final y = ((widget.table['y_pos'] ?? widget.table['yPos'] ?? 0) as num).toDouble();
    // Fall back to the canvas-assigned grid slot when nothing has been
    // saved yet (both zero). Once the user drags, we save real coords
    // and this branch stops firing.
    return (x == 0 && y == 0) ? widget.autoX : x;
  }
  double get _baseY {
    final x = ((widget.table['x_pos'] ?? widget.table['xPos'] ?? 0) as num).toDouble();
    final y = ((widget.table['y_pos'] ?? widget.table['yPos'] ?? 0) as num).toDouble();
    return (x == 0 && y == 0) ? widget.autoY : y;
  }

  @override
  Widget build(BuildContext context) {
    final left = _clampX(_dragX ?? _baseX);
    final top = _clampY(_dragY ?? _baseY);
    final label = widget.table['label']?.toString() ?? '?';
    final status = widget.table['status']?.toString() ?? 'available';
    final shape = widget.table['shape']?.toString() ?? 'square';
    final color = _statusColor(status);

    return Positioned(
      left: left,
      top: top,
      child: GestureDetector(
        // A single onPan works well on mobile — no need to require a
        // long-press since the canvas is edit-only.
        onPanStart: (_) => setState(() { _dragging = true; }),
        onPanUpdate: (d) {
          setState(() {
            _dragX = _clampX((_dragX ?? _baseX) + d.delta.dx);
            _dragY = _clampY((_dragY ?? _baseY) + d.delta.dy);
          });
        },
        onPanEnd: (_) {
          final finalX = (_dragX ?? _baseX).round();
          final finalY = (_dragY ?? _baseY).round();
          setState(() { _dragging = false; });
          if (finalX != _baseX.round() || finalY != _baseY.round()) {
            widget.onDragEnd(widget.table, finalX, finalY);
          }
          // Clear the pending drag once the parent has stored the new
          // position — otherwise on next rebuild we'd snap back briefly.
          _dragX = null;
          _dragY = null;
        },
        onTap: widget.onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 80),
          width: widget.tileSize,
          height: widget.tileSize,
          decoration: BoxDecoration(
            color: color.withValues(alpha: 0.15),
            border: Border.all(
              color: _dragging ? AppColors.primary : color,
              width: _dragging ? 2.5 : 1.5,
            ),
            borderRadius: BorderRadius.circular(shape == 'round' ? 44 : 10),
            boxShadow: _dragging
                ? [BoxShadow(color: Colors.black.withValues(alpha: 0.15),
                    blurRadius: 6, offset: const Offset(0, 3))]
                : null,
          ),
          child: Stack(
            alignment: Alignment.center,
            children: [
              Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(label, style: TextStyle(
                    fontSize: 22, fontWeight: FontWeight.w900, color: color,
                  )),
                  Text('${widget.table['seats'] ?? 4} seats',
                    style: const TextStyle(fontSize: 10,
                      color: AppColors.textSecondary)),
                  Text(status.toUpperCase(),
                    style: TextStyle(fontSize: 8,
                      fontWeight: FontWeight.w900, color: color,
                      letterSpacing: 1)),
                ],
              ),
              if (widget.saving)
                const Positioned(
                  bottom: 4, right: 4,
                  child: SizedBox(width: 10, height: 10,
                    child: CircularProgressIndicator(strokeWidth: 1.5)),
                ),
            ],
          ),
        ),
      ),
    );
  }

  Color _statusColor(String s) {
    switch (s) {
      case 'occupied':  return AppColors.warning;
      case 'reserved':  return AppColors.info;
      case 'cleaning':  return AppColors.textSecondary;
      case 'blocked':   return AppColors.error;
      case 'available':
      default:          return AppColors.success;
    }
  }
}
