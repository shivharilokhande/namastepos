// NamastePOS — GST port parity (2026-09-05, review #2).
//
// Every expected figure below was produced by running the BACKEND's
// `computeGstBreakdown` (namastepos_backend/src/services/gstService2.js) on
// the same lines. If this file goes red after a change to lib/utils/gst.dart,
// the phone and the server disagree on a bill — fix the port, not the test.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:namastepos/utils/gst.dart';

GstBreakdown _intra(List<GstLine> lines) => computeGstBreakdown(lines);
GstBreakdown _inter(List<GstLine> lines) =>
    computeGstBreakdown(lines, isInterState: true);

void main() {
  group('computeGstBreakdown mirrors gstService2.js', () {
    test('2 × ₹100 @5% → tax 10.00, CGST 5.00, SGST 5.00', () {
      final r = _intra([const GstLine(price: 100, qty: 2, gstPct: 5)]);
      expect(r.totalGst, 10.00);
      expect(r.cgst, 5.00);
      expect(r.sgst, 5.00);
      expect(r.igst, 0);
      expect(r.breakdown, {'5': 10.0});
      expect(r.isInterState, isFalse);
    });

    test('mixed slabs: ₹100 @5% + ₹200 @18% → 41.00 split 20.50 / 20.50', () {
      final r = _intra([
        const GstLine(price: 100, qty: 1, gstPct: 5),
        const GstLine(price: 200, qty: 1, gstPct: 18),
      ]);
      expect(r.totalGst, 41.00);
      expect(r.cgst, 20.50);
      expect(r.sgst, 20.50);
      expect(r.breakdown, {'5': 5.0, '18': 36.0});
    });

    test('odd paisa lands on SGST exactly like the server (₹10.10 @5%)', () {
      // 0.505 → toFixed(2) → 0.51; half 0.255 → 0.26 CGST, 0.25 SGST.
      final r = _intra([const GstLine(price: 10.10, qty: 1, gstPct: 5)]);
      expect(r.totalGst, 0.51);
      expect(r.cgst, 0.26);
      expect(r.sgst, 0.25);
    });

    test('paise rounding: 3 × ₹33.33 @5% → 5.00 (99.99 × 5% = 4.9995)', () {
      final r = _intra([const GstLine(price: 33.33, qty: 3, gstPct: 5)]);
      expect(r.totalGst, 5.00);
      expect(r.cgst, 2.50);
      expect(r.sgst, 2.50);
    });

    test('28% slab, odd total: 3 × ₹99.99 → 83.99 split 41.99 / 42.00', () {
      final r = _intra([const GstLine(price: 99.99, qty: 3, gstPct: 28)]);
      expect(r.totalGst, 83.99);
      expect(r.cgst, 41.99);
      expect(r.sgst, 42.00);
    });

    test('fractional qty (weight-priced): 0.5 × ₹450 @5% → 11.25 = 5.63 + 5.62',
        () {
      final r = _intra([const GstLine(price: 450, qty: 0.5, gstPct: 5)]);
      expect(r.totalGst, 11.25);
      expect(r.cgst, 5.63);
      expect(r.sgst, 5.62);
    });

    test('a 0% slab contributes a zero bucket, not an error', () {
      final r = _intra([
        const GstLine(price: 50, qty: 2, gstPct: 0),
        const GstLine(price: 10, qty: 1, gstPct: 12),
      ]);
      expect(r.totalGst, 1.20);
      expect(r.cgst, 0.60);
      expect(r.sgst, 0.60);
      expect(r.breakdown, {'0': 0.0, '12': 1.2});
    });

    test('four slabs of ₹1 each: running-sum order matches JS (0.32 / 0.31)',
        () {
      final r = _intra([
        const GstLine(price: 1, qty: 1, gstPct: 5),
        const GstLine(price: 1, qty: 1, gstPct: 18),
        const GstLine(price: 1, qty: 1, gstPct: 12),
        const GstLine(price: 1, qty: 1, gstPct: 28),
      ]);
      expect(r.totalGst, 0.63);
      expect(r.cgst, 0.32);
      expect(r.sgst, 0.31);
      expect(r.breakdown, {'5': 0.05, '12': 0.12, '18': 0.18, '28': 0.28});
    });

    test('inter-state puts everything on IGST', () {
      final r = _inter([
        const GstLine(price: 100, qty: 1, gstPct: 5),
        const GstLine(price: 200, qty: 1, gstPct: 18),
      ]);
      expect(r.igst, 41.00);
      expect(r.cgst, 0);
      expect(r.sgst, 0);
      expect(r.totalGst, 41.00);
      expect(r.isInterState, isTrue);
    });

    test('empty cart → zero everywhere', () {
      final r = _intra(const []);
      expect(r.isZero, isTrue);
      expect(r.breakdown, isEmpty);
    });
  });

  group('GST scheme mirrors gstSchemeService.js', () {
    test('only composition charges the diner no GST', () {
      expect(gstSchemeChargesNoGst('composition'), isTrue);
      expect(gstSchemeChargesNoGst('regular'), isFalse);
      expect(gstSchemeChargesNoGst('specified_premises'), isFalse);
      expect(gstSchemeChargesNoGst(null), isFalse);
    });

    test('default slab per scheme: composition 0, specified 18, else 5', () {
      expect(defaultGstPctForScheme('composition'), 0);
      expect(defaultGstPctForScheme('specified_premises'), 18);
      expect(defaultGstPctForScheme('regular'), 5);
      expect(defaultGstPctForScheme(null), 5);
      expect(defaultGstPctForScheme('garbage'), 5);
    });
  });

  group('the create-order body defers tax to the server', () {
    // The contract (2026-09-05): an OMITTED `tax` means "server computes GST
    // from the menu"; a literal 0 means "client computed zero". Both order
    // POST bodies in the app must therefore never carry a `tax` key. This is
    // a source pin because the two builders sit behind sqflite/dio and are
    // not unit-constructible here.
    for (final path in [
      'lib/providers/orders_provider.dart',
      'lib/services/repositories.dart',
    ]) {
      test('$path sends no tax field', () {
        final src = File(path).readAsStringSync();
        expect(src.contains("'tax': tax"), isFalse,
            reason: '$path puts `tax` in the create-order JSON; the server '
                'would read that as a client-computed figure.');
      });
    }
  });
}
