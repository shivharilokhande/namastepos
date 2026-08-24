// NamastePOS — Mobile Reservations (H14).
//
// Floor manager view of today's bookings. Pick a date, see who's coming
// at what time, mark seated/cancelled, or create a new reservation.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../utils/error_humanizer.dart';
import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../../utils/formatters.dart';
import '../../widgets/home_bottom_nav.dart';
import '../../widgets/home_drawer_button.dart';

class ReservationsScreen extends StatefulWidget {
  const ReservationsScreen({super.key});

  @override
  State<ReservationsScreen> createState() => _ReservationsScreenState();
}

class _ReservationsScreenState extends State<ReservationsScreen> {
  DateTime _date = DateTime.now();
  List<dynamic> _list = [];
  bool _loading = true;

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    final biz = context.read<AuthProvider>().business;
    if (biz == null) { setState(() => _loading = false); return; }
    try {
      _list = await ApiService.instance.listReservations(
          biz.id, date: _date.toIso8601String().substring(0, 10));
    } catch (e) {
      // Bug fix (B30): don't swallow — log so silent 500s on the
      // reservations endpoint aren't invisible.
      debugPrint('[reservations] load failed: $e');
    }
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _newReservation() async {
    final name = TextEditingController();
    final phone = TextEditingController();
    final party = TextEditingController(text: '2');
    TimeOfDay time = TimeOfDay.now();
    await showDialog(
      context: context,
      builder: (_) => StatefulBuilder(
        builder: (_, set) => AlertDialog(
          title: const Text('New reservation'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(controller: name, decoration: const InputDecoration(labelText: 'Guest name')),
              TextField(controller: phone, decoration: const InputDecoration(labelText: 'Phone')),
              TextField(
                controller: party,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(labelText: 'Party size'),
              ),
              const SizedBox(height: 8),
              ListTile(
                title: Text('Time: ${time.format(context)}'),
                trailing: const Icon(Icons.access_time),
                onTap: () async {
                  final t = await showTimePicker(context: context, initialTime: time);
                  if (t != null) set(() => time = t);
                },
              ),
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
            ElevatedButton(
              onPressed: () async {
                // Capture the Navigator + Messenger BEFORE the await so we
                // don't reach through a BuildContext across the async gap
                // (analyzer: use_build_context_synchronously).
                final biz = context.read<AuthProvider>().business!;
                final navigator = Navigator.of(context);
                final messenger = ScaffoldMessenger.of(context);
                final dt = DateTime(_date.year, _date.month, _date.day, time.hour, time.minute);
                try {
                  await ApiService.instance.upsertReservation(biz.id, {
                    'customerName': name.text,
                    'customerPhone': phone.text,
                    'partySize': int.tryParse(party.text) ?? 2,
                    'reservedAt': dt.toIso8601String(),
                  });
                  navigator.pop();
                  _load();
                } catch (e) {
                  messenger.showSnackBar(
                    SnackBar(content: Text(humanizeError(e))),
                  );
                }
              },
              child: const Text('Book'),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        leading: (ModalRoute.of(context)?.isFirst ?? true) ? const HomeDrawerButton() : null,
        title: const Text('Reservations'),
        actions: [
          IconButton(
            icon: const Icon(Icons.calendar_today),
            onPressed: () async {
              final picked = await showDatePicker(
                context: context, initialDate: _date,
                firstDate: DateTime.now().subtract(const Duration(days: 7)),
                lastDate: DateTime.now().add(const Duration(days: 90)),
              );
              if (picked != null) { setState(() { _date = picked; _loading = true; }); _load(); }
            },
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        icon: const Icon(Icons.add),
        label: const Text('Book'),
        onPressed: _newReservation,
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : Column(
              children: [
                Padding(
                  padding: const EdgeInsets.all(12),
                  child: Text(AppFmt.date(_date),
                      style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
                ),
                Expanded(
                  child: _list.isEmpty
                      ? const Center(child: Text('No reservations today'))
                      : ListView.separated(
                          itemCount: _list.length,
                          separatorBuilder: (_, __) => const Divider(height: 1),
                          itemBuilder: (_, i) => _row(_list[i] as Map<String, dynamic>),
                        ),
                ),
              ],
            ),
    bottomNavigationBar: const HomeBottomNav(),
    );
  }

  Widget _row(Map<String, dynamic> r) {
    // Backend serializes camelCase (reservedAt / customerName / partySize /
    // customerPhone). Previous code only read snake_case → everything was
    // null → list rendered as "?" placeholders. Read both as a safety net.
    final at = DateTime.tryParse(
        (r['reservedAt'] ?? r['reserved_at']) as String? ?? '');
    final name = (r['customerName'] ?? r['customer_name']) as String?;
    final party = r['partySize'] ?? r['party_size'];
    final phone = (r['customerPhone'] ?? r['customer_phone']) as String?;
    return ListTile(
      leading: CircleAvatar(
        backgroundColor: AppColors.primary.withValues(alpha: 0.15),
        child: Text(at == null ? '?' : '${at.hour}:${at.minute.toString().padLeft(2, '0')}',
            style: const TextStyle(
                color: AppColors.primary, fontWeight: FontWeight.w800, fontSize: 12)),
      ),
      title: Text(name ?? 'Guest',
          style: const TextStyle(fontWeight: FontWeight.w800)),
      subtitle: Text('${party ?? '?'} guests${phone == null || phone.isEmpty ? '' : ' · $phone'}'),
      trailing: Container(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
        decoration: BoxDecoration(
          color: _statusColor(r['status'] as String?),
          borderRadius: BorderRadius.circular(4),
        ),
        child: Text(((r['status'] as String?) ?? 'pending').toUpperCase(),
            style: const TextStyle(
                color: Colors.white,
                fontSize: 10,
                fontWeight: FontWeight.w800)),
      ),
      onTap: () => _detail(r),
    );
  }

  Color _statusColor(String? s) => switch (s) {
        'seated' => Colors.green,
        'cancelled' => Colors.red,
        _ => Colors.amber,
      };

  void _detail(Map<String, dynamic> r) {
    showModalBottomSheet(
      context: context,
      builder: (_) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.event_seat),
              title: const Text('Mark seated'),
              onTap: () async {
                Navigator.pop(context);
                final biz = context.read<AuthProvider>().business!;
                await ApiService.instance.upsertReservation(biz.id,
                    {'status': 'seated'}, id: r['id'] as String);
                _load();
              },
            ),
            ListTile(
              leading: const Icon(Icons.cancel, color: Colors.red),
              title: const Text('Cancel reservation'),
              onTap: () async {
                Navigator.pop(context);
                final biz = context.read<AuthProvider>().business!;
                await ApiService.instance.upsertReservation(biz.id,
                    {'status': 'cancelled'}, id: r['id'] as String);
                _load();
              },
            ),
          ],
        ),
      ),
    );
  }
}
