// NamastePOS — tenant support / ticketing (X7 mobile side).
// Raise a ticket and read replies from the NamastePOS support team.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../constants/colors.dart';
import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../../utils/error_humanizer.dart';

class SupportScreen extends StatefulWidget {
  const SupportScreen({super.key});
  @override
  State<SupportScreen> createState() => _SupportScreenState();
}

class _SupportScreenState extends State<SupportScreen> {
  List<dynamic> _tickets = [];
  bool _loading = true;
  String? _error;

  String get _bizId => context.read<AuthProvider>().business?.id ?? '';

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    if (_bizId.isEmpty) { setState(() => _loading = false); return; }
    setState(() { _loading = true; _error = null; });
    try {
      _tickets = await ApiService.instance.listSupportTickets(_bizId);
    } catch (e) {
      _error = humanizeError(e);
    }
    if (mounted) setState(() => _loading = false);
  }

  Color _statusColor(String s) {
    switch (s) {
      case 'open': return AppColors.warning;
      case 'pending': return AppColors.info;
      case 'resolved': return AppColors.success;
      default: return AppColors.textHint;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Support')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _newTicket,
        icon: const Icon(Icons.add),
        label: const Text('New ticket'),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Text(_error!))
              : RefreshIndicator(
                  onRefresh: _load,
                  child: _tickets.isEmpty
                      ? ListView(children: const [
                          SizedBox(height: 120),
                          Center(child: Text('No tickets yet.\nTap “New ticket” if you need help.',
                              textAlign: TextAlign.center, style: TextStyle(color: AppColors.textSecondary))),
                        ])
                      : ListView.separated(
                          padding: const EdgeInsets.all(12),
                          itemCount: _tickets.length,
                          separatorBuilder: (_, __) => const SizedBox(height: 8),
                          itemBuilder: (_, i) {
                            final t = _tickets[i] as Map;
                            return Card(
                              child: ListTile(
                                title: Text(t['subject']?.toString() ?? '',
                                    maxLines: 1, overflow: TextOverflow.ellipsis),
                                subtitle: Text('${t['messageCount'] ?? 0} messages'),
                                trailing: Container(
                                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                                  decoration: BoxDecoration(
                                    color: _statusColor(t['status']?.toString() ?? '').withValues(alpha: 0.15),
                                    borderRadius: BorderRadius.circular(12),
                                  ),
                                  child: Text(t['status']?.toString() ?? '',
                                      style: TextStyle(fontSize: 11, color: _statusColor(t['status']?.toString() ?? ''))),
                                ),
                                onTap: () => _openThread(t['id'].toString()),
                              ),
                            );
                          },
                        ),
                ),
    );
  }

  Future<void> _newTicket() async {
    final created = await showModalBottomSheet<bool>(
      context: context, isScrollControlled: true,
      builder: (_) => const _NewTicketSheet(),
    );
    if (created == true) _load();
  }

  Future<void> _openThread(String id) async {
    await Navigator.push(context, MaterialPageRoute(builder: (_) => _TicketThread(ticketId: id)));
    _load();
  }
}

class _NewTicketSheet extends StatefulWidget {
  const _NewTicketSheet();
  @override
  State<_NewTicketSheet> createState() => _NewTicketSheetState();
}

class _NewTicketSheetState extends State<_NewTicketSheet> {
  final _subject = TextEditingController();
  final _body = TextEditingController();
  String _priority = 'normal';
  bool _busy = false;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(
        left: 16, right: 16, top: 16,
        bottom: MediaQuery.of(context).viewInsets.bottom + 16),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        const Text('New ticket', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
        const SizedBox(height: 12),
        TextField(controller: _subject, decoration: const InputDecoration(labelText: 'Subject')),
        const SizedBox(height: 8),
        DropdownButtonFormField<String>(
          initialValue: _priority,
          decoration: const InputDecoration(labelText: 'Priority'),
          items: const [
            DropdownMenuItem(value: 'low', child: Text('Low')),
            DropdownMenuItem(value: 'normal', child: Text('Normal')),
            DropdownMenuItem(value: 'high', child: Text('High')),
            DropdownMenuItem(value: 'critical', child: Text('Critical — service down')),
          ],
          onChanged: (v) => setState(() => _priority = v ?? 'normal'),
        ),
        const SizedBox(height: 8),
        TextField(controller: _body, maxLines: 4, decoration: const InputDecoration(labelText: 'Describe the issue')),
        const SizedBox(height: 16),
        FilledButton(
          onPressed: _busy ? null : _submit,
          child: Text(_busy ? 'Submitting…' : 'Submit ticket'),
        ),
      ]),
    );
  }

  Future<void> _submit() async {
    if (_subject.text.trim().isEmpty || _body.text.trim().isEmpty) return;
    setState(() => _busy = true);
    try {
      final bizId = context.read<AuthProvider>().business!.id;
      await ApiService.instance.createSupportTicket(bizId,
          subject: _subject.text.trim(), body: _body.text.trim(), priority: _priority);
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      if (mounted) {
        setState(() => _busy = false);
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(humanizeError(e))));
      }
    }
  }
}

class _TicketThread extends StatefulWidget {
  final String ticketId;
  const _TicketThread({required this.ticketId});
  @override
  State<_TicketThread> createState() => _TicketThreadState();
}

class _TicketThreadState extends State<_TicketThread> {
  Map<String, dynamic>? _ticket;
  bool _loading = true;
  final _reply = TextEditingController();
  bool _sending = false;

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    final bizId = context.read<AuthProvider>().business!.id;
    try {
      _ticket = await ApiService.instance.getSupportTicket(bizId, widget.ticketId);
    } catch (_) {}
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _send() async {
    if (_reply.text.trim().isEmpty) return;
    setState(() => _sending = true);
    try {
      final bizId = context.read<AuthProvider>().business!.id;
      _ticket = await ApiService.instance.replySupportTicket(bizId, widget.ticketId, _reply.text.trim());
      _reply.clear();
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(humanizeError(e))));
    }
    if (mounted) setState(() => _sending = false);
  }

  @override
  Widget build(BuildContext context) {
    final messages = (_ticket?['messages'] as List?) ?? const [];
    final closed = _ticket?['status'] == 'closed';
    return Scaffold(
      appBar: AppBar(title: Text(_ticket?['subject']?.toString() ?? 'Ticket')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : Column(children: [
              Expanded(
                child: ListView.builder(
                  padding: const EdgeInsets.all(12),
                  itemCount: messages.length,
                  itemBuilder: (_, i) {
                    final m = messages[i] as Map;
                    final mine = m['authorType'] == 'tenant';
                    return Align(
                      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
                      child: Container(
                        margin: const EdgeInsets.only(bottom: 8),
                        padding: const EdgeInsets.all(10),
                        constraints: const BoxConstraints(maxWidth: 300),
                        decoration: BoxDecoration(
                          color: mine ? AppColors.primary.withValues(alpha: 0.12) : AppColors.surface,
                          borderRadius: BorderRadius.circular(10),
                          border: Border.all(color: AppColors.divider),
                        ),
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Text(mine ? 'You' : 'NamastePOS support',
                              style: const TextStyle(fontSize: 10, color: AppColors.textSecondary)),
                          const SizedBox(height: 2),
                          Text(m['body']?.toString() ?? ''),
                        ]),
                      ),
                    );
                  },
                ),
              ),
              if (!closed)
                SafeArea(
                  child: Padding(
                    padding: const EdgeInsets.all(8),
                    child: Row(children: [
                      Expanded(child: TextField(controller: _reply,
                          decoration: const InputDecoration(hintText: 'Type a reply…', border: OutlineInputBorder()))),
                      const SizedBox(width: 8),
                      IconButton.filled(
                        onPressed: _sending ? null : _send,
                        icon: const Icon(Icons.send)),
                    ]),
                  ),
                ),
            ]),
    );
  }
}
