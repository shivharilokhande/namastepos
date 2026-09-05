// NamastePOS — the entitlement guard.
//
// 2026-09-05. The founder removed Voice POS from a plan in the admin console
// and the mic stayed on a paying customer's phone: the POS screen gated the
// mic on device capability alone and never asked what the business was
// entitled to. Nothing in the repo could have caught that — the feature had
// been shipped without a gate, and "shipped without a gate" looked exactly
// like "correctly ungated".
//
// These tests are what looks now.
//
// WHAT IS ACTUALLY ENFORCEABLE HERE — read this before trusting the file.
// No test can prove that a screen someone writes tomorrow asks about a plan.
// A gate is an `if` in a build method; its absence is not a token. What CAN
// be enforced, and is:
//
//   1. Backend parity. The mobile catalog must equal the backend's
//      WELL_KNOWN_FEATURE_KEYS. Adding a key server-side turns this red until
//      someone writes down what mobile does about it — which is the moment a
//      new feature's gate gets discussed instead of forgotten.
//   2. One chokepoint. Every gate call site passes a `Features.` constant.
//      Raw literals are rejected, so a key is never invented at a call site
//      and a typo can never become a permanent silent grant.
//   3. The surface record is true. Each key declares gated / noSurface /
//      ungatedByDesign, and the declaration is checked against the real call
//      sites in lib/. Delete a gate and its key's `gated` claim fails; add a
//      gate for a key marked noSurface and that fails too.
//   4. Fail-closed semantics. Unknown entitlements deny — asserted directly
//      on PlanInfo, and pinned for the mic specifically.
//
// The hole this leaves, stated plainly: a brand-new screen for a brand-new
// feature, added with no gate and no catalog entry, passes everything here.
// Closing that needs a review habit or a server-side rule, not a Dart test.
// What this file removes is the SILENT failure — every key that exists is
// accounted for, and every gate that exists is real.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:namastepos/constants/feature_keys.dart';
import 'package:namastepos/models/plan_info.dart';

/// Every `.dart` file under lib/, with comments stripped, so a usage example
/// inside a doc comment is never mistaken for a call site.
Map<String, String> _libSources() {
  final out = <String, String>{};
  final dir = Directory('lib');
  if (!dir.existsSync()) {
    fail('Run from the package root: lib/ not found at ${dir.absolute.path}');
  }
  for (final f in dir.listSync(recursive: true).whereType<File>()) {
    if (!f.path.endsWith('.dart')) continue;
    out[f.path] = _stripComments(f.readAsStringSync());
  }
  return out;
}

/// Removes `//` line comments and `/* */` blocks. Deliberately simple: it
/// also blanks a `//` sequence inside a string literal, which for this file's
/// purposes only ever makes the scan MORE conservative.
String _stripComments(String src) {
  final noBlocks = src.replaceAll(RegExp(r'/\*.*?\*/', dotAll: true), '');
  return noBlocks
      .split('\n')
      .map((line) {
        final i = line.indexOf('//');
        return i == -1 ? line : line.substring(0, i);
      })
      .join('\n');
}

/// Any mention of a key by its constant. This — not the narrower call-site
/// pattern below — is what decides whether the app "reads" a key, because a
/// key can be consumed indirectly (staff_screen maps staff permissions to
/// feature keys and checks them in a loop) and a scan that only understood
/// literal `has(Features.x)` calls would call those gates missing.
final _constantUse = RegExp(r'\bFeatures\.([A-Za-z0-9]+)\b');

/// Anything that reads an entitlement: `auth.has(x)`, `plan.has(x)`,
/// `PlanGate.allows(context, x)`, `featureKey: x`, and the two upsell-label
/// helpers that take a key. Used ONLY to catch raw string literals — a key
/// named at a call site instead of coming from the catalog.
final _gateCall = RegExp(
  r'''(?:\.has\(\s*([^)\s,]+)\s*\)'''
  r'''|PlanGate\.allows\(\s*[^,]+,\s*([^)\s]+)\s*\)'''
  r'''|featureKey:\s*([^,)\n]+?)\s*[,)\n]'''
  r'''|(?:upgradeTargetPhrase|serverUpgradeLabel)\(\s*[^,]+,\s*([^)\s]+)\s*\))''',
);

/// Files that legitimately mention keys without gating on them: the catalog
/// itself, and the billing screen's human-readable feature LABELS (it prints
/// every plan's contents, which is not a gate).
const _catalogFiles = {
  'lib/constants/feature_keys.dart',
  'lib/screens/billing/billing_screen.dart',
};

/// `Features.voicePos` -> `voice_pos`, by reflection-free lookup against the
/// catalog: constant names are camelCase of the snake_case key.
String? _keyForConstant(String expr) {
  if (!expr.startsWith('Features.')) return null;
  final name = expr.substring('Features.'.length);
  for (final key in kFeatureCatalog) {
    final parts = key.split('_');
    final camel = parts.first +
        parts.skip(1).map((p) => p[0].toUpperCase() + p.substring(1)).join();
    if (camel == name) return key;
  }
  return null;
}

void main() {
  final sources = _libSources();

  // Every gate call site in the app: key -> the files that gate on it.
  final gatedKeys = <String, Set<String>>{};
  final literalOffenders = <String>[];
  final unknownConstants = <String>[];

  for (final entry in sources.entries) {
    final path = entry.key.replaceAll(r'\', '/');
    if (_catalogFiles.contains(path)) continue;

    // What this file reads.
    for (final m in _constantUse.allMatches(entry.value)) {
      final expr = 'Features.${m.group(1)}';
      final key = _keyForConstant(expr);
      if (key == null) {
        unknownConstants.add('$path: $expr');
        continue;
      }
      gatedKeys.putIfAbsent(key, () => <String>{}).add(path);
    }

    // Whether it names any key the wrong way.
    for (final m in _gateCall.allMatches(entry.value)) {
      final raw = (m.group(1) ?? m.group(2) ?? m.group(3) ?? m.group(4) ?? '')
          .trim();
      if (raw.isEmpty) continue;
      // A parameter or local being forwarded (PlanGate's own `featureKey`,
      // staff_screen's `featKey`) is not a key NAME — the constant is at the
      // caller, which the scan above sees separately. Only a hard-coded
      // string is an offence.
      if (raw.startsWith("'") || raw.startsWith('"')) {
        literalOffenders.add('$path: $raw');
      }
    }
  }

  group('feature key chokepoint', () {
    test('every gate names a constant that is in the catalog', () {
      expect(unknownConstants, isEmpty,
          reason: 'A gate reads a Features.* constant with no matching key in '
              'kFeatureCatalog — the gate can never pass.\n'
              '  ${unknownConstants.join('\n  ')}');
    });

    test('no gate names a feature key as a raw string literal', () {
      expect(
        literalOffenders,
        isEmpty,
        reason: 'Use a Features.* constant from lib/constants/feature_keys.dart.\n'
            'A literal here is how voice_pos could have been misspelled into a '
            'permanent grant that nothing would ever have reported.\n'
            'Offenders:\n  ${literalOffenders.join('\n  ')}',
      );
    });

    test('the mobile catalog matches the backend catalog exactly', () {
      // Paths from the Flutter package root. CI checks out the whole repo and
      // runs with working-directory: namastepos_flutter, so these resolve in
      // CI as well as on a dev machine.
      //
      // The canonical list is config/featureRegistry.js (one entry per key,
      // `key: '...'`). Older checkouts carry the same list as
      // WELL_KNOWN_FEATURE_KEYS in services/featureService.js; both are read
      // so this check never silently stops running across that move.
      final registry = File('../namastepos_backend/src/config/featureRegistry.js');
      final legacy = File('../namastepos_backend/src/services/featureService.js');

      Set<String>? backendKeys;
      if (registry.existsSync()) {
        backendKeys = RegExp(r"^\s*key:\s*'([a-z0-9_]+)'", multiLine: true)
            .allMatches(registry.readAsStringSync())
            .map((m) => m.group(1)!)
            .toSet();
      } else if (legacy.existsSync()) {
        final block = RegExp(
          r'const WELL_KNOWN_FEATURE_KEYS\s*=\s*\[(.*?)\];',
          dotAll: true,
        ).firstMatch(legacy.readAsStringSync());
        if (block != null) {
          backendKeys = RegExp("'([a-z0-9_]+)'")
              .allMatches(block.group(1)!)
              .map((m) => m.group(1)!)
              .toSet();
        }
      }

      if (backendKeys == null || backendKeys.isEmpty) {
        fail('Could not read the backend feature catalog from '
            '${registry.absolute.path} or ${legacy.absolute.path}. This is '
            'the only check that notices a key added server-side and never '
            'gated on mobile — it must not be allowed to quietly no-op. Run '
            'from a full repo checkout, or point it at the list\'s new home.');
      }

      expect(
        kFeatureCatalog.difference(backendKeys),
        isEmpty,
        reason: 'Mobile knows keys the backend catalog does not. Either the '
            'key was renamed server-side (the gate is now dead and the '
            'feature is silently on for everyone) or it never existed.',
      );
      expect(
        backendKeys.difference(kFeatureCatalog),
        isEmpty,
        reason: 'The backend can grant keys this app has never heard of. '
            'Classify each one in kMobileSurfaces — gated, noSurface, or '
            'ungatedByDesign with a reason. This is the check that turns "a '
            'new feature shipped without a gate" from an invisible bug into a '
            'red build.',
      );
    });

    test('every catalog key declares what mobile does about it', () {
      expect(kMobileSurfaces.keys.toSet(), equals(kFeatureCatalog));
    });
  });

  group('declared surfaces match the real call sites', () {
    test('every key marked gated has a real gate in lib/', () {
      final missing = <String>[];
      kMobileSurfaces.forEach((key, surface) {
        if (surface.kind != MobileSurface.gated) return;
        if (!gatedKeys.containsKey(key)) {
          missing.add('$key (expected at: ${surface.note})');
        }
      });
      expect(
        missing,
        isEmpty,
        reason: 'These keys claim a gated mobile surface but nothing in lib/ '
            'reads them. Either the gate was deleted — which is the Voice POS '
            'bug happening again — or the surface was removed and the entry '
            'should say so.\n  ${missing.join('\n  ')}',
      );
    });

    test('no key marked noSurface is secretly gated somewhere', () {
      final unexpected = <String>[];
      kMobileSurfaces.forEach((key, surface) {
        if (surface.kind != MobileSurface.noSurface) return;
        final where = gatedKeys[key];
        if (where != null) {
          unexpected.add('$key gated in ${where.join(', ')}');
        }
      });
      expect(
        unexpected,
        isEmpty,
        reason: 'A mobile surface was built for a key recorded as having '
            'none. Flip the entry to MobileSurface.gated and name where the '
            'gate lives, so the check above starts protecting it.\n'
            '  ${unexpected.join('\n  ')}',
      );
    });

    test('no key marked ungatedByDesign has quietly grown a gate', () {
      final unexpected = <String>[];
      kMobileSurfaces.forEach((key, surface) {
        if (surface.kind != MobileSurface.ungatedByDesign) return;
        final where = gatedKeys[key];
        if (where != null) {
          unexpected.add('$key gated in ${where.join(', ')}');
        }
      });
      expect(unexpected, isEmpty,
          reason: 'Reclassify as gated (with the location) so the gate is '
              'protected from deletion.\n  ${unexpected.join('\n  ')}');
    });

    test('every ungatedByDesign entry carries a reason', () {
      kMobileSurfaces.forEach((key, surface) {
        if (surface.kind != MobileSurface.ungatedByDesign) return;
        expect(surface.note.length, greaterThan(20),
            reason: '$key is ungated on purpose but does not say why. An '
                'unexplained ungated surface is indistinguishable from a '
                'forgotten one.');
      });
    });
  });

  group('entitlements fail closed', () {
    test('an unknown plan grants nothing at all', () {
      final unknown = PlanInfo.unknown();
      expect(unknown.loaded, isFalse);
      for (final key in kFeatureCatalog) {
        expect(unknown.has(key), isFalse,
            reason: 'Unloaded entitlements granted "$key". A feature the '
                'customer is not paying for must not appear while data loads.');
      }
    });

    test('a plan that lists a feature but is not loaded still denies', () {
      // The dangerous middle state: a PlanInfo built by hand, or restored
      // from somewhere that is not a server answer.
      final notLoaded = PlanInfo(
        tierKind: 'pro',
        features: {Features.voicePos, Features.kds},
      );
      expect(notLoaded.has(Features.voicePos), isFalse);
      expect(notLoaded.has(Features.kds), isFalse);
    });

    test('a loaded plan grants exactly what the server sent', () {
      final loaded = PlanInfo.fromMap(<String, dynamic>{
        'tierKind': 'pro',
        'features': [Features.kds, Features.captainMode],
      });
      expect(loaded.loaded, isTrue);
      expect(loaded.has(Features.kds), isTrue);
      expect(loaded.has(Features.captainMode), isTrue);
      // The reported bug, as an assertion: a plan that does not list
      // voice_pos does not grant voice_pos.
      expect(loaded.has(Features.voicePos), isFalse);
    });

    test('an empty feature list from the server is an ANSWER, not a gap', () {
      final loaded = PlanInfo.fromMap(<String, dynamic>{'features': <String>[]});
      expect(loaded.loaded, isTrue);
      expect(loaded.has(Features.pos), isFalse);
    });
  });

  group('voice POS regression pin (2026-09-05)', () {
    test('the mic is gated on the plan, not only on the device', () {
      final src = sources['lib/screens/pos/new_order_screen.dart'];
      expect(src, isNotNull, reason: 'new_order_screen.dart moved or vanished');
      expect(
        src!.contains('Features.voicePos'),
        isTrue,
        reason: 'The POS screen no longer checks the voice_pos entitlement. '
            'This is exactly the reported bug: the mic gated on device '
            'capability alone, shown to a customer whose plan had Voice POS '
            'removed in the admin console.',
      );
      expect(
        kMobileSurfaces[Features.voicePos]!.kind,
        MobileSurface.gated,
        reason: 'voice_pos must stay classified as a gated mobile surface.',
      );
    });

    test('the device-capability check alone can no longer draw the mic', () {
      final src = sources['lib/screens/pos/new_order_screen.dart']!;
      // The mic is rendered under a single condition. Whatever it is called,
      // it must not be the raw offerMicButton value.
      expect(
        RegExp(r'if \(\s*_?voiceDeviceReady\s*\)').hasMatch(src),
        isFalse,
        reason: 'The mic is drawn on device readiness alone again. It must be '
            'device readiness AND the voice_pos entitlement.',
      );
    });
  });
}
