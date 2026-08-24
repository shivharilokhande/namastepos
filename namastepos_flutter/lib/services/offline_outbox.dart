// Offline-first outbox for NamastePOS Flutter POS (F13)
//
// Drops alongside the existing OrderProvider. When the app is offline, order
// creates go into the local SQLite outbox keyed by client_id. A background
// poller drains the outbox when network returns.
//
// Backend-side idempotency is provided by orderService.create's client_id
// uniqueness, so retrying a queued order never duplicates.

import 'dart:async';
import 'dart:convert';
import 'package:sqflite/sqflite.dart';
import 'package:dio/dio.dart';
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:uuid/uuid.dart';

class OfflineOutbox {
  static final OfflineOutbox _i = OfflineOutbox._();
  factory OfflineOutbox() => _i;
  OfflineOutbox._();

  Database? _db;
  final _uuid = const Uuid();
  StreamSubscription? _connSub;
  Timer? _drainTimer;
  Dio? _api;

  Future<void> init({required Dio api}) async {
    _api = api;
    _db = await openDatabase(
      'namastepos_outbox.db',
      version: 1,
      onCreate: (db, v) async {
        await db.execute('''
          CREATE TABLE outbox (
            client_id TEXT PRIMARY KEY,
            endpoint TEXT NOT NULL,
            method TEXT NOT NULL,
            body TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            last_attempt_at INTEGER,
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT
          )
        ''');
      },
    );
    // Fix (2026-08-23, flagged by analyze unrelated_type_equality_checks):
    // connectivity_plus v6 emits List<ConnectivityResult>; comparing the
    // list to a single enum was always true/false — the offline check
    // NEVER matched, so orders were never queued when offline.
    _connSub = Connectivity().onConnectivityChanged.listen((results) {
      final online =
          results.any((c) => c != ConnectivityResult.none);
      if (online) drainOnce();
    });
    _drainTimer = Timer.periodic(const Duration(seconds: 30), (_) => drainOnce());
  }

  Future<String> enqueue({
    required String endpoint,
    required String method,
    required Map<String, dynamic> body,
  }) async {
    final clientId = body['clientId'] as String? ?? _uuid.v4();
    body['clientId'] = clientId;
    await _db!.insert('outbox', {
      'client_id': clientId,
      'endpoint': endpoint,
      'method': method,
      'body': jsonEncode(body),
      'created_at': DateTime.now().millisecondsSinceEpoch,
    }, conflictAlgorithm: ConflictAlgorithm.replace);
    return clientId;
  }

  /// Attempt to send the body now; if offline, queue it.
  Future<Response?> sendOrQueue({
    required String endpoint,
    required String method,
    required Map<String, dynamic> body,
  }) async {
    final conn = await Connectivity().checkConnectivity();
    final offline = conn.every((c) => c == ConnectivityResult.none);
    if (offline) {
      await enqueue(endpoint: endpoint, method: method, body: body);
      return null;
    }
    try {
      final r = method == 'POST'
          ? await _api!.post(endpoint, data: body)
          : await _api!.put(endpoint, data: body);
      return r;
    } catch (err) {
      // Loud diagnostic — previously a bare `catch (_) {}` swallowed every
      // failure (auth, validation, network). Orders ended up in the local
      // outbox forever while the dashboard saw nothing. Print the body
      // and the error so the actual cause is visible in `flutter run`.
      // ignore: avoid_print
      print('OUTBOX: $method $endpoint FAILED — $err');
      if (err is DioException) {
        // ignore: avoid_print
        print('OUTBOX status=${err.response?.statusCode} body=${err.response?.data}');
        // H4 fix (2026-08-23, review): a 4xx is a REJECTION, not an
        // outage — retrying a validation-failed order every 30s for
        // 25 min then silently purging it misled the cashier into
        // thinking it was placed. Rethrow so the UI shows the error.
        // (401 = expired session and 429 = throttled ARE retryable.)
        final sc = err.response?.statusCode ?? 0;
        if (sc >= 400 && sc < 500 && sc != 401 && sc != 408 && sc != 429) {
          rethrow;
        }
      }
      await enqueue(endpoint: endpoint, method: method, body: body);
      return null;
    }
  }

  /// Items that have failed this many times get dropped from the queue.
  /// Stops 404s for deleted businesses from retrying every 30s forever.
  static const int _maxAttempts = 50;

  Future<int> drainOnce() async {
    if (_db == null) return 0;
    // First, purge anything that's been failing forever — usually 4xx
    // responses (404 because business no longer exists, 400 because the
    // payload schema has changed). Beyond _maxAttempts these are dead.
    final purged = await _db!.delete(
      'outbox', where: 'attempts > ?', whereArgs: [_maxAttempts]);
    if (purged > 0) {
      // ignore: avoid_print
      print('OUTBOX: purged $purged entries that exceeded $_maxAttempts attempts');
    }
    final rows = await _db!.query('outbox', orderBy: 'created_at', limit: 20);
    int sent = 0;
    for (final row in rows) {
      try {
        final body = jsonDecode(row['body'] as String) as Map<String, dynamic>;
        final r = (row['method'] == 'POST')
            ? await _api!.post(row['endpoint'] as String, data: body)
            : await _api!.put(row['endpoint'] as String, data: body);
        if (r.statusCode != null && r.statusCode! < 300) {
          await _db!.delete('outbox', where: 'client_id = ?', whereArgs: [row['client_id']]);
          sent++;
        }
      } catch (err) {
        // Surface drain failures too — these are the queued items that
        // have been failing on every 30s drain since the user first hit
        // the bug. Without printing them the user never knows their
        // orders are stuck.
        // ignore: avoid_print
        print('OUTBOX DRAIN: ${row['method']} ${row['endpoint']} '
            '(attempt ${(row['attempts'] as int) + 1}) FAILED — $err');
        if (err is DioException) {
          // ignore: avoid_print
          print('OUTBOX DRAIN status=${err.response?.statusCode} body=${err.response?.data}');
        }
        await _db!.update('outbox',
          {
            'attempts': (row['attempts'] as int) + 1,
            'last_attempt_at': DateTime.now().millisecondsSinceEpoch,
            'last_error': err.toString(),
          },
          where: 'client_id = ?', whereArgs: [row['client_id']],
        );
      }
    }
    return sent;
  }

  Future<int> pendingCount() async {
    final r = await _db!.rawQuery('SELECT COUNT(*) AS n FROM outbox');
    return Sqflite.firstIntValue(r) ?? 0;
  }

  Future<void> dispose() async {
    await _connSub?.cancel();
    _drainTimer?.cancel();
    await _db?.close();
  }
}
