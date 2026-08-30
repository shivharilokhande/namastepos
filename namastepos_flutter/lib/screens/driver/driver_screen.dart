// NamastePOS — Driver / delivery rider screen.
//
// Designed for the rider's personal phone. Shows assigned deliveries, lets
// them mark picked-up / delivered, and pings the dispatcher with the rider's
// live coordinates every 30 seconds while a job is active.
//
// Backend endpoints used:
//   GET  /v1/businesses/:id/delivery-assignments/live
//   POST /v1/businesses/:id/drivers/:id/ping        (lat/lng heartbeat)
//   PUT  /v1/businesses/:id/delivery-assignments/:id/status
//
// We don't ship a full map view here — too much complexity for the MVP.
// A "Navigate" button hands off the destination address to whatever maps
// app the rider has installed (Google Maps deep link).

import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:geolocator/geolocator.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../constants/colors.dart';
import '../../utils/error_humanizer.dart';
import '../../utils/formatters.dart';
import '../../services/api_service.dart';
import '../../widgets/home_bottom_nav.dart';
import '../../widgets/home_drawer_button.dart';

class DriverScreen extends StatefulWidget {
  final String businessId;
  final String driverId;
  const DriverScreen({super.key, required this.businessId, required this.driverId});

  @override
  State<DriverScreen> createState() => _DriverScreenState();
}

class _DriverScreenState extends State<DriverScreen> {
  List<Map<String, dynamic>> _jobs = [];
  bool _loading = true;
  Timer? _pollTimer;
  Timer? _pingTimer;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
    _pollTimer = Timer.periodic(const Duration(seconds: 15), (_) => _load());
    // Heartbeat starts lazily in _load() — only once there's an actual
    // job. Fix (2026-08-22): the unconditional 30s timer popped the
    // system location-permission dialog on owners who just peeked at
    // the screen with zero deliveries, and dismissing it mid-navigation
    // crashed to a black screen on some devices.
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    _pingTimer?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final r = await ApiService.instance.dio
          .get('/businesses/${widget.businessId}/delivery-assignments/live');
      final all = (r.data['assignments'] as List).cast<Map>().toList();
      // Only show jobs assigned to me
      _jobs = all
          .where((a) => a['driver_id'] == widget.driverId)
          .map((a) => a.cast<String, dynamic>())
          .toList();
      _error = null;
      // Lazy heartbeat (2026-08-22): only ask for location once there's
      // a real delivery to track; stop when the queue empties.
      if (_jobs.isNotEmpty && _pingTimer == null) {
        _pingTimer =
            Timer.periodic(const Duration(seconds: 30), (_) => _ping());
        _ping();
      } else if (_jobs.isEmpty && _pingTimer != null) {
        _pingTimer!.cancel();
        _pingTimer = null;
      }
    } catch (e) {
      _error = e.toString();
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _ping() async {
    double lat = 0, lng = 0;
    try {
      // Permissions are requested on first ping; we ignore failures so the
      // rider isn't blocked from working if they tap "deny".
      var perm = await Geolocator.checkPermission();
      if (perm == LocationPermission.denied) {
        perm = await Geolocator.requestPermission();
      }
      if (perm != LocationPermission.denied && perm != LocationPermission.deniedForever) {
        final pos = await Geolocator.getCurrentPosition(
            desiredAccuracy: LocationAccuracy.medium,
            timeLimit: const Duration(seconds: 4));
        lat = pos.latitude;
        lng = pos.longitude;
      }
    } catch (_) { /* skip — backend still gets a heartbeat */ }
    try {
      await ApiService.instance.driverPing(
          widget.businessId, widget.driverId, lat: lat, lng: lng);
    } catch (e) {
      // Heartbeats fire every 30s — failing once is normal (cellular dead
      // zone). Don't UI-toast; just print so the dispatcher's heatmap
      // staleness can be debugged from the flutter run console if needed.
      debugPrint('driverPing failed: $e');
    }
  }

  Future<void> _openMaps(String? address) async {
    if (address == null || address.isEmpty) return;
    final q = Uri.encodeComponent(address);
    // Google Maps universal link works on iOS + Android + macOS.
    final url = Uri.parse('https://www.google.com/maps/search/?api=1&query=$q');
    if (await canLaunchUrl(url)) {
      await launchUrl(url, mode: LaunchMode.externalApplication);
    }
  }

  Future<void> _markStatus(String assignmentId, String status) async {
    try {
      await ApiService.instance.dio.put(
        '/businesses/${widget.businessId}/delivery-assignments/$assignmentId/status',
        data: {'status': status},
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Marked $status')),
      );
      _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(humanizeError(e)), backgroundColor: Colors.red),
      );
    }
  }

  void _copyAddress(String? address) {
    if (address == null || address.isEmpty) return;
    Clipboard.setData(ClipboardData(text: address));
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Address copied — paste into Google Maps')),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        leading: (ModalRoute.of(context)?.isFirst ?? true) ? const HomeDrawerButton() : null,
        title: const Text('My deliveries'),
        backgroundColor: AppColors.primary,
        foregroundColor: Colors.white,
        actions: [
          IconButton(icon: const Icon(Icons.refresh), onPressed: _load),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Text('Could not load — $_error', textAlign: TextAlign.center)))
              : _jobs.isEmpty
                  ? const Center(child: Padding(
                      padding: EdgeInsets.all(24),
                      child: Text('No deliveries assigned. Wait for the next call.',
                          style: TextStyle(fontSize: 16, color: Colors.grey),
                          textAlign: TextAlign.center)))
                  : ListView.separated(
                      padding: const EdgeInsets.all(12),
                      itemCount: _jobs.length,
                      separatorBuilder: (_, __) => const SizedBox(height: 8),
                      itemBuilder: (_, i) => _jobCard(_jobs[i]),
                    ),
    bottomNavigationBar: const HomeBottomNav(),
    );
  }

  Widget _jobCard(Map<String, dynamic> j) {
    final status = (j['status'] as String?) ?? 'assigned';
    final address = j['address'] as String? ?? '';
    final orderNo = j['order_no'] ?? '?';
    final fee = j['delivery_fee_paise'] != null
        // `as num` not `as int`: JSON numbers can deserialize as double, which
        // would throw on `as int`. num covers both.
        ? (j['delivery_fee_paise'] as num) / 100
        : null;

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text('Order #$orderNo',
                    style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  decoration: BoxDecoration(
                    color: _statusColor(status),
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(status.toUpperCase(),
                      style: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.w600)),
                ),
              ],
            ),
            const SizedBox(height: 8),
            if (address.isNotEmpty) ...[
              const Text('Delivery address', style: TextStyle(fontSize: 11, color: Colors.grey)),
              Text(address, style: const TextStyle(fontSize: 14)),
            ],
            if (fee != null) ...[
              const SizedBox(height: 4),
              Text('Your fee: ${AppFmt.money(fee, decimals: true)}',
                  style: const TextStyle(fontSize: 13, color: Colors.green)),
            ],
            const SizedBox(height: 10),
            Wrap(
              spacing: 8, runSpacing: 4,
              children: [
                OutlinedButton.icon(
                  icon: const Icon(Icons.copy, size: 16),
                  label: const Text('Copy'),
                  onPressed: () => _copyAddress(address),
                ),
                OutlinedButton.icon(
                  icon: const Icon(Icons.navigation, size: 16),
                  label: const Text('Navigate'),
                  onPressed: () => _openMaps(address),
                ),
                if (status == 'assigned')
                  ElevatedButton(
                    onPressed: () => _markStatus(j['id'], 'picked_up'),
                    child: const Text('Picked up'),
                  ),
                if (status == 'picked_up')
                  ElevatedButton(
                    style: ElevatedButton.styleFrom(backgroundColor: Colors.green),
                    onPressed: () => _markStatus(j['id'], 'delivered'),
                    child: const Text('Delivered'),
                  ),
                if (status != 'delivered' && status != 'failed')
                  TextButton(
                    onPressed: () => _markStatus(j['id'], 'failed'),
                    child: const Text('Failed', style: TextStyle(color: Colors.red)),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Color _statusColor(String s) => switch (s) {
        'assigned' => Colors.orange,
        'picked_up' => Colors.blue,
        'delivered' => Colors.green,
        'failed' => Colors.red,
        _ => Colors.grey,
      };
}
