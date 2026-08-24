// Unit tests for Telemetry PII scrubbing (FF-211 + FF-260).
//
// The Sentry init path itself requires a valid DSN — we skip it. The
// scrubber logic is regex-based and can be tested in isolation by
// exercising the same regexes via the public `capture` path and
// asserting `debugPrint` doesn't leak PII.

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:namastepos/services/telemetry.dart';

void main() {
  group('Telemetry PII scrubbing', () {
    late List<String> printed;
    late DebugPrintCallback original;

    setUp(() {
      printed = <String>[];
      original = debugPrint;
      debugPrint = (String? msg, {int? wrapWidth}) {
        if (msg != null) printed.add(msg);
      };
      Telemetry.install();
    });

    tearDown(() {
      debugPrint = original;
    });

    test('scrubs email in captured error', () {
      Telemetry.capture(Exception('user shivlokhande7080@gmail.com bad login'));
      expect(printed.join('\n'), contains('<redacted:email>'));
      expect(printed.join('\n'), isNot(contains('shivlokhande7080@gmail.com')));
    });

    test('scrubs Indian mobile number', () {
      Telemetry.capture(Exception('called 9518956711 twice'));
      final all = printed.join('\n');
      expect(all, contains('<redacted:phone>'));
      expect(all, isNot(contains('9518956711')));
    });

    test('scrubs JWT + Bearer', () {
      Telemetry.capture(Exception(
        'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc',
      ));
      final all = printed.join('\n');
      expect(all, contains('<redacted:token>'));
      expect(all, isNot(contains('eyJhbGciOiJIUzI1NiJ9')));
    });

    test('leaves non-PII content untouched', () {
      Telemetry.capture(Exception('order #42 subtotal ₹540'));
      expect(printed.join('\n'), contains('order #42'));
      expect(printed.join('\n'), contains('₹540'));
    });
  });
}
