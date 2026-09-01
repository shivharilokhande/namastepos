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

import 'database_service.dart';

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

  // Review 2026-08-28: prevent overlapping drains. drainOnce is triggered by
  // BOTH the 30s timer AND the connectivity listener; concurrent runs re-POST
  // the same rows. This mutex serialises them.
  bool _draining = false;

  /// Entries that have exhausted retries are kept (not deleted) so a create
  /// lost during a long outage isn't silently purged — surfaced to the UI.
  Future<int> deadLetterCount() async {
    if (_db == null) return 0;
    final r = await _db!.rawQuery(
      'SELECT COUNT(*) AS n FROM outbox WHERE attempts > ?', [_maxAttempts]);
    return Sqflite.firstIntValue(r) ?? 0;
  }

  static const int _drainPageSize = 20;

  /// FB-21 (2026-09-01): cheap reachability probe. On captive-portal / dead-WAN
  /// wifi the device reports "connected" but every POST times out — draining
  /// then just inflates `attempts` and eventually dead-letters good orders. We
  /// gate the drain on an actual /health round-trip so a transient outage no
  /// longer burns retry budget.
  Future<bool> _reachable() async {
    if (_api == null) return false;
    try {
      final r = await _api!.get('/health',
          options: Options(receiveTimeout: const Duration(seconds: 5),
                           sendTimeout: const Duration(seconds: 5)));
      return (r.statusCode ?? 500) < 500;
    } catch (_) {
      return false;
    }
  }

  Future<int> drainOnce() async {
    if (_db == null) return 0;
    if (_draining) return 0;
    _draining = true;
    try {
      // Skip the (network) reachability probe entirely when nothing is queued —
      // avoids a needless /health ping every 30s on the happy path.
      if (await activePendingCount() == 0) return 0;
      // FB-21: only drain when the server is actually reachable.
      if (!await _reachable()) return 0;
      // FB-22 (2026-09-01): drain the FULL backlog, not just the first 20. Keep
      // pulling pages while a page comes back completely sent (more likely
      // waiting); stop as soon as a page is partial (nothing more to send now).
      int total = 0;
      while (true) {
        final n = await _drainBatch();
        total += n;
        if (n < _drainPageSize) break;
      }
      return total;
    } finally {
      _draining = false;
    }
  }

  /// Sends up to one page of queued rows. Returns the number successfully sent.
  Future<int> _drainBatch() async {
    // Review 2026-08-28: DO NOT delete exhausted entries — a create that fails
    // through a long outage would vanish while the cashier thinks it saved.
    // Instead we leave them (surfaced via deadLetterCount) and simply skip them
    // in the drain query below (attempts <= _maxAttempts).
    final rows = await _db!.query(
      'outbox', where: 'attempts <= ?', whereArgs: [_maxAttempts],
      orderBy: 'created_at', limit: _drainPageSize);
    int sent = 0;
    for (final row in rows) {
      try {
        final body = jsonDecode(row['body'] as String) as Map<String, dynamic>;
        final r = (row['method'] == 'POST')
            ? await _api!.post(row['endpoint'] as String, data: body)
            : await _api!.put(row['endpoint'] as String, data: body);
        if (r.statusCode != null && r.statusCode! < 300) {
          await _db!.delete('outbox', where: 'client_id = ?', whereArgs: [row['client_id']]);
          // FB-09 (2026-09-01): mark the corresponding local order synced so it
          // stops showing as a phantom "pending" row until the next full load().
          await _markOrderSynced(row['endpoint'] as String, row['method'] as String,
              row['client_id'] as String);
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
        int nextAttempts = (row['attempts'] as int) + 1;
        if (err is DioException) {
          // ignore: avoid_print
          print('OUTBOX DRAIN status=${err.response?.statusCode} body=${err.response?.data}');
          // 2026-08-31 review fix: a permanent 4xx rejection (validation, a
          // stale points-redeem, a deleted business 404) will NEVER succeed on
          // retry — jump it straight to dead-letter so the cashier is told at
          // once instead of after 25 min of pointless retries. 401/408/429 are
          // transient and keep their normal +1 backoff.
          final sc = err.response?.statusCode ?? 0;
          if (sc >= 400 && sc < 500 && sc != 401 && sc != 408 && sc != 429) {
            nextAttempts = _maxAttempts + 1;
          }
        }
        await _db!.update('outbox',
          {
            'attempts': nextAttempts,
            'last_attempt_at': DateTime.now().millisecondsSinceEpoch,
            'last_error': err.toString(),
          },
          where: 'client_id = ?', whereArgs: [row['client_id']],
        );
      }
    }
    return sent;
  }

  /// FB-09: flip the local order's synced flag to 1 after its create POST
  /// drains successfully. Best-effort — a cache miss just means the row
  /// reconciles on the next load() instead.
  Future<void> _markOrderSynced(String endpoint, String method, String clientId) async {
    if (method != 'POST' || !endpoint.endsWith('/orders')) return;
    try {
      final db = await DatabaseService.instance.db;
      await db.update('orders', {'synced': 1},
          where: 'id = ?', whereArgs: [clientId]);
    } catch (_) { /* cache-only nicety */ }
  }

  Future<int> pendingCount() async {
    if (_db == null) return 0;
    final r = await _db!.rawQuery('SELECT COUNT(*) AS n FROM outbox');
    return Sqflite.firstIntValue(r) ?? 0;
  }

  /// Orders still queued and being retried (not yet dead-lettered).
  Future<int> activePendingCount() async {
    if (_db == null) return 0;
    final r = await _db!.rawQuery(
      'SELECT COUNT(*) AS n FROM outbox WHERE attempts <= ?', [_maxAttempts]);
    return Sqflite.firstIntValue(r) ?? 0;
  }

  /// The dead-lettered rows, so a "failed to sync" screen can list them.
  Future<List<Map<String, dynamic>>> deadLetters() async {
    if (_db == null) return const [];
    return _db!.query('outbox',
        where: 'attempts > ?', whereArgs: [_maxAttempts], orderBy: 'created_at');
  }

  /// Reset a dead-lettered row's attempt counter and try to send it again.
  Future<void> retryDeadLetters() async {
    if (_db == null) return;
    await _db!.update('outbox', {'attempts': 0, 'last_error': null},
        where: 'attempts > ?', whereArgs: [_maxAttempts]);
    await drainOnce();
  }

  /// Permanently drop a queued/failed row (cashier chose to discard).
  Future<void> discard(String clientId) async {
    if (_db == null) return;
    await _db!.delete('outbox', where: 'client_id = ?', whereArgs: [clientId]);
  }

  Future<void> dispose() async {
    await _connSub?.cancel();
    _drainTimer?.cancel();
    await _db?.close();
  }
}
