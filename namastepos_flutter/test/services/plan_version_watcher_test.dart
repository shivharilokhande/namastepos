// NamastePOS — X-Plan-Version staleness detection.
//
// 2026-09-05. The founder removed Voice POS from a customer's plan and the mic
// stayed visible in the running app. The gate was added, and a 5-minute poll
// bounded the damage — but the backend was already stamping the answer on
// every authenticated business response (`X-Plan-Version`, a fingerprint of
// the tenant's effective entitlement) and the Flutter client read none of it.
//
// These tests pin the five behaviours that make reading it safe to do on the
// hot path of every single request in the app:
//
//   1. a changed fingerprint triggers exactly one refresh
//   2. an unchanged fingerprint triggers none
//   3. the FIRST fingerprint ever seen seeds a baseline without refreshing
//   4. a missing or malformed header is ignored
//   5. the refresh's own response cannot recurse into another refresh
//
// Plus the structural check: the watcher is fed from the dio interceptor and
// nowhere else, which is the property that stops a future endpoint from
// silently opting out.

import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:namastepos/services/plan_version_watcher.dart';

/// Two well-formed fingerprints in the shape featureService._fingerprint
/// produces (a 12-char hex SHA-1 slice).
const _v1 = 'a1b2c3d4e5f6';
const _v2 = '0f1e2d3c4b5a';
const _v3 = '9988776655aa';

void main() {
  group('PlanVersionWatcher', () {
    late int refreshes;
    late PlanVersionWatcher w;

    setUp(() {
      refreshes = 0;
      w = PlanVersionWatcher(onChanged: () async => refreshes++);
    });

    test('the first header ever seen seeds the baseline without refreshing',
        () async {
      w.note(_v1);
      await w.inFlight;
      expect(refreshes, 0,
          reason: 'The first header after login is not a change. Firing here '
              'would mean a redundant /auth/me on every cold start and after '
              'every sign-in, when login already hydrated the plan.');
      expect(w.seen, _v1, reason: 'the baseline must still have been recorded');
    });

    test('an unchanged header triggers no refresh, however many arrive',
        () async {
      w.note(_v1); // seed
      for (var i = 0; i < 50; i++) {
        w.note(_v1);
      }
      await w.inFlight;
      expect(refreshes, 0,
          reason: 'This is the path taken by virtually every response in the '
              'app. It has to cost nothing.');
    });

    test('a changed header triggers exactly one refresh', () async {
      w.note(_v1); // seed
      w.note(_v2);
      await w.inFlight;
      expect(refreshes, 1);
      expect(w.seen, _v2);
    });

    test('a burst of responses carrying the same NEW header refreshes once',
        () async {
      w.note(_v1); // seed
      // A POS polls several endpoints at once; a plan change lands on all of
      // their responses in the same tick. One refresh, not eight.
      for (var i = 0; i < 8; i++) {
        w.note(_v2);
      }
      await w.inFlight;
      expect(refreshes, 1, reason: 'refresh storm — the guard did not hold');
    });

    test('a further change while a refresh is in flight does not stack', () async {
      final gate = Completer<void>();
      var calls = 0;
      final watcher = PlanVersionWatcher(onChanged: () async {
        calls++;
        await gate.future; // hold the refresh open
      });
      watcher.note(_v1); // seed
      watcher.note(_v2); // fires, and blocks
      expect(watcher.refreshing, isTrue);
      watcher.note(_v3); // arrives mid-flight
      watcher.note(_v3);
      expect(calls, 1, reason: 'at most one refresh may be in flight');

      gate.complete();
      await watcher.inFlight;
      expect(watcher.refreshing, isFalse);

      // ...and the change seen mid-flight was NOT swallowed: the baseline was
      // deliberately left alone so the next response re-detects it.
      expect(watcher.seen, _v2);
      watcher.note(_v3);
      await watcher.inFlight;
      expect(calls, 2);
      expect(watcher.seen, _v3);
    });

    test("the refresh's own response does not recurse", () async {
      // The refresh is an HTTP call; its response goes back through the same
      // interceptor. Feed the watcher from inside the callback to prove that
      // cannot loop.
      var calls = 0;
      late PlanVersionWatcher watcher;
      watcher = PlanVersionWatcher(onChanged: () async {
        calls++;
        watcher.note(_v2); // the refresh response, carrying the new version
        watcher.note(_v3); // and a different one, for good measure
      });
      watcher.note(_v1); // seed
      watcher.note(_v2);
      await watcher.inFlight;
      expect(calls, 1,
          reason: 'the refresh re-entered the watcher and triggered itself');
    });

    group('malformed and missing headers are ignored', () {
      // Every one of these must leave the watcher exactly as it was: no
      // baseline learned from junk, and above all no refresh fired. A watcher
      // that treated garbage as a new version would refresh on every response.
      const junk = <String?>[
        null, // header absent (an ungated route, or a cold backend cache)
        '', // present but empty
        '   ', // whitespace only
        'null', // a stringified null from some proxy
        'unknown',
        'not-a-hex-value',
        'a1b2c3', // too short to be a fingerprint
        'zzzzzzzzzzzz', // right length, not hex
        'a1b2c3d4e5f6!', // trailing junk
        '<html>502</html>',
      ];

      test('none of them seeds a baseline', () {
        for (final bad in junk) {
          final fresh = PlanVersionWatcher(onChanged: () async => fail('fired'));
          fresh.note(bad);
          expect(fresh.seen, isNull, reason: 'learned a baseline from: $bad');
        }
      });

      test('none of them triggers a refresh after a real baseline', () async {
        w.note(_v1); // seed with a good one
        for (final bad in junk) {
          w.note(bad);
        }
        await w.inFlight;
        expect(refreshes, 0);
        expect(w.seen, _v1, reason: 'junk overwrote a good baseline');
      });
    });

    test('a refresh that throws is swallowed and unblocks the guard', () async {
      final watcher = PlanVersionWatcher(
        onChanged: () async => throw Exception('offline'),
      );
      watcher.note(_v1); // seed
      watcher.note(_v2); // fires and throws
      await watcher.inFlight; // must not rethrow
      expect(watcher.refreshing, isFalse,
          reason: 'a failed refresh left the guard latched — no later change '
              'would ever be acted on');

      // And the next change still works.
      var ok = 0;
      watcher.onChanged = () async => ok++;
      watcher.note(_v3);
      await watcher.inFlight;
      expect(ok, 1);
    });

    test('with no callback wired the watcher is inert, not broken', () async {
      final bare = PlanVersionWatcher();
      bare.note(_v1);
      bare.note(_v2);
      await bare.inFlight;
      expect(bare.seen, _v2);
      expect(bare.refreshing, isFalse);
    });

    test('reset() clears the baseline so the next tenant seeds its own', () async {
      w.note(_v1);
      w.reset();
      expect(w.seen, isNull);
      w.note(_v2); // a different tenant's fingerprint — a SEED, not a change
      await w.inFlight;
      expect(refreshes, 0,
          reason: 'signing in as another business must not read the previous '
              "tenant's fingerprint as a plan change");
    });
  });

  group('the header is read at ONE chokepoint', () {
    // The whole value of this fix is that it lives in the dio interceptor, so
    // an endpoint added later cannot forget it. If someone moves the read to a
    // call site, this goes red.
    late String apiSrc;

    setUpAll(() {
      final f = File('lib/services/api_service.dart');
      if (!f.existsSync()) {
        fail('Run from the package root: ${f.absolute.path} not found');
      }
      apiSrc = f.readAsStringSync();
    });

    test('ApiService feeds the watcher from its interceptor', () {
      expect(apiSrc.contains('onResponse:'), isTrue,
          reason: 'the response interceptor is gone — nothing reads '
              'X-Plan-Version on a successful request any more');
      expect(
        RegExp(r'_planVersions\.note\(').allMatches(apiSrc).length,
        2,
        reason: 'The header must be read exactly twice: once on the success '
            'path (onResponse) and once on the failure path (onError, where a '
            '402 FEATURE_LOCKED is the clearest possible signal that the plan '
            'changed). More call sites than that means the read has leaked out '
            'of the chokepoint.',
      );
    });

    test('signing out resets the watcher', () {
      expect(apiSrc.contains('_planVersions.reset()'), isTrue,
          reason: 'clearTokens() no longer resets the fingerprint; this device '
              "would carry one tenant's plan version into the next session");
    });

    test('AuthProvider reuses refreshPlan, not a second write path', () {
      final auth = File('lib/providers/auth_provider.dart').readAsStringSync();
      expect(auth.contains('onPlanVersionChanged'), isTrue,
          reason: 'nothing is wired to the watcher — the header is read and '
              'then dropped on the floor');
      final hook = RegExp(
        r'Future<void> _onPlanVersionChanged\(\) async \{(.*?)\n  \}',
        dotAll: true,
      ).firstMatch(auth);
      expect(hook, isNotNull, reason: 'the callback body moved or was renamed');
      expect(hook!.group(1)!.contains('refreshPlan()'), isTrue,
          reason: 'must reuse AuthProvider.refreshPlan() so there is one '
              'writer of the plan state');
      expect(
        hook.group(1)!.contains('refreshPlanIfStale'),
        isFalse,
        reason: 'refreshPlanIfStale() no-ops for entitlementMaxAge after the '
            'last fetch. A fingerprint change is positive evidence that the '
            'cached answer is wrong regardless of its age — routing through '
            'the staleness check would reintroduce the window this closes.',
      );
    });

    test('the 5-minute poll is still there as the backstop', () {
      final home = File('lib/screens/home/home_screen.dart').readAsStringSync();
      expect(home.contains('refreshPlanIfStale()'), isTrue,
          reason: 'The header only helps an app that is MAKING requests, and '
              'the backend stamps it best-effort (no header when its feature '
              'cache is cold). The timer is what bounds those cases. It must '
              'not be removed as "redundant".');
    });
  });
}
