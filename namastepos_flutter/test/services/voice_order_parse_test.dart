// Voice ordering — the parser, which is the only part of the feature that is
// pure Dart and therefore the only part that can be pinned down by a test.
// The recogniser itself is the OS's and is not mocked here.
//
// What these tests protect:
//   * Hindi/Marathi counting words ("do chai", "ek masala dosa"), which is the
//     whole reason the feature exists for this market.
//   * The two words deliberately NOT treated as numbers — 'chai' (a drink) and
//     'che' (an ambiguous particle) — because a false number silently doubles
//     a customer's bill.
//   * Misses being RETURNED rather than dropped, so the confirm sheet can say
//     what it could not understand.

import 'package:flutter_test/flutter_test.dart';
import 'package:namastepos/models/menu_item.dart';
import 'package:namastepos/services/voice_order_service.dart';

MenuItem _item(String name, {double price = 50}) {
  final now = DateTime(2026, 1, 1);
  return MenuItem(
    id: name.toLowerCase().replaceAll(' ', '-'),
    businessId: 'b1',
    name: name,
    category: 'Food',
    price: price,
    createdAt: now,
    updatedAt: now,
  );
}

void main() {
  final menu = <MenuItem>[
    _item('Masala Chai', price: 30),
    _item('Masala Dosa', price: 90),
    _item('Butter Naan', price: 40),
    _item('Paneer Tikka', price: 250),
    _item('Cold Coffee', price: 120),
  ];

  group('quantities', () {
    test('English leading number word', () {
      final r = VoiceOrderService.parse('two butter naan', menu);
      expect(r.lines.length, 1);
      expect(r.lines.first.name, 'Butter Naan');
      expect(r.lines.first.qty, 2);
    });

    test('digits', () {
      final r = VoiceOrderService.parse('3 paneer tikka', menu);
      expect(r.lines.single.qty, 3);
    });

    test('Hindi counting words', () {
      expect(VoiceOrderService.parse('do masala chai', menu).lines.single.qty, 2);
      expect(VoiceOrderService.parse('ek masala dosa', menu).lines.single.qty, 1);
      expect(VoiceOrderService.parse('teen butter naan', menu).lines.single.qty, 3);
      expect(VoiceOrderService.parse('paanch cold coffee', menu).lines.single.qty, 5);
    });

    test('Devanagari, for when the recogniser does not transliterate', () {
      final r = VoiceOrderService.parse('दो masala chai', menu);
      expect(r.lines.single.qty, 2);
    });

    test('trailing quantity, as Hindi word order often puts it', () {
      final r = VoiceOrderService.parse('masala chai do', menu);
      expect(r.lines.single.name, 'Masala Chai');
      expect(r.lines.single.qty, 2);
    });

    test('a leading quantity wins; a trailing one is not multiplied in', () {
      final r = VoiceOrderService.parse('two masala dosa two', menu);
      expect(r.lines.single.qty, 2);
    });

    test('counting nouns between number and dish are ignored', () {
      final r = VoiceOrderService.parse('do plate masala dosa', menu);
      expect(r.lines.single.name, 'Masala Dosa');
      expect(r.lines.single.qty, 2);
    });

    test('an absurd quantity is clamped rather than billed', () {
      final r = VoiceOrderService.parse('500 masala chai', menu);
      expect(r.lines.single.qty, 99);
    });
  });

  group('words that must never be read as numbers', () {
    test('"chai" is a drink, not six', () {
      final r = VoiceOrderService.parse('chai', menu);
      expect(r.lines.single.name, 'Masala Chai');
      expect(r.lines.single.qty, 1);
    });

    test('"che" is not treated as a quantity', () {
      final r = VoiceOrderService.parse('che masala chai', menu);
      expect(r.lines.single.qty, 1);
    });
  });

  group('splitting', () {
    test('English and Hindi conjunctions both split lines', () {
      final r = VoiceOrderService.parse(
          'do masala chai aur ek butter naan and two masala dosa', menu);
      expect(r.lines.length, 3);
      expect(r.lines.map((l) => '${l.qty}x${l.name}').toList(), [
        '2xMasala Chai',
        '1xButter Naan',
        '2xMasala Dosa',
      ]);
    });

    test('commas split lines', () {
      final r = VoiceOrderService.parse('two butter naan, three masala chai', menu);
      expect(r.lines.length, 2);
    });
  });

  group('matching', () {
    test('an exact name is a confident match', () {
      final r = VoiceOrderService.parse('masala dosa', menu);
      expect(r.lines.single.confident, isTrue);
      expect(r.lines.single.item?.id, 'masala-dosa');
    });

    test('a single mis-heard letter still matches', () {
      final r = VoiceOrderService.parse('two panner tikka', menu);
      expect(r.lines.single.name, 'Paneer Tikka');
      expect(r.lines.single.qty, 2);
    });

    test('a partial name matches but is NOT presented as certain', () {
      final r = VoiceOrderService.parse('two masala', menu);
      expect(r.lines, isNotEmpty);
      expect(r.lines.single.confident, isFalse,
          reason: '"masala" is ambiguous between Chai and Dosa; the confirm '
              'sheet must flag it rather than pick silently');
    });

    test('unmatched speech is returned, never dropped', () {
      final r = VoiceOrderService.parse('two biryani', menu);
      expect(r.lines, isEmpty);
      expect(r.unmatched, contains('biryani'));
    });

    test('a mixed utterance reports both halves', () {
      final r = VoiceOrderService.parse('do masala chai aur ek biryani', menu);
      expect(r.lines.single.name, 'Masala Chai');
      expect(r.unmatched, contains('biryani'));
    });
  });

  group('degenerate input', () {
    test('empty', () {
      expect(VoiceOrderService.parse('', menu).isEmpty, isTrue);
      expect(VoiceOrderService.parse('   ', menu).isEmpty, isTrue);
    });

    test('an empty menu matches nothing and does not throw', () {
      final r = VoiceOrderService.parse('do chai', <MenuItem>[]);
      expect(r.lines, isEmpty);
      expect(r.unmatched, isNotEmpty);
    });

    test('a bare quantity with no dish is not an order', () {
      final r = VoiceOrderService.parse('do plate', menu);
      expect(r.lines, isEmpty);
      expect(r.unmatched, isEmpty);
    });
  });
}
