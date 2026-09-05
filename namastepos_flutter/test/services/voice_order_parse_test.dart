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

  // ── The 2026-09-05 device report ────────────────────────────────────────
  //
  // Founder, on a real phone, said "amul pavbhaji". The recogniser heard
  // "amol pav bhaji" — a fair hearing. The matcher put KOLHAPURI Pav Bhaji on
  // the order, because every word counted the same: `pav` and `bhaji` hit on
  // both dishes and the one word that says WHICH dish it is, `amul`, was the
  // one that missed. 2 hits out of 3 words = 0.667 for both, a coin flip.
  //
  // Two defects, both permanently pinned here:
  //   1. tokens are now weighted by how much they narrow the menu down, so a
  //      hit on `pav` is nearly free and a miss on `amul` is decisive;
  //   2. `_wordsMatch` can fuzzy-match FOUR-letter words, so "amol" reaches
  //      "amul" at all — Indian dish names carry their distinguishing word in
  //      four letters constantly (amul, aloo, gobi, corn, jain, dahi, soya).
  group('pav bhaji — the reported mis-match', () {
    final bhajiMenu = <MenuItem>[
      ...menu,
      _item('Amul Pav Bhaji', price: 140),
      _item('Kolhapuri Pav Bhaji', price: 160),
    ];

    test('"amol pav bhaji" resolves to Amul, not Kolhapuri', () {
      final r = VoiceOrderService.parse('amol pav bhaji', bhajiMenu);
      expect(r.lines.single.name, 'Amul Pav Bhaji',
          reason: 'the ONE discriminating word must decide the match');
      expect(r.lines.single.confident, isTrue);
      expect(r.lines.single.ambiguous, isFalse);
    });

    test('"pav bhaji" alone is genuinely ambiguous and must ask', () {
      final r = VoiceOrderService.parse('do pav bhaji', bhajiMenu);
      final line = r.lines.single;
      expect(line.qty, 2);
      expect(line.confident, isFalse,
          reason: 'nothing in the words chooses between the two bhajis');
      expect(line.ambiguous, isTrue);
      expect(line.options.map((o) => o.name).toList(),
          containsAll(<String>['Amul Pav Bhaji', 'Kolhapuri Pav Bhaji']));
    });

    test('Kolhapuri-only menu: "amol pav bhaji" is a flagged guess', () {
      final only = <MenuItem>[...menu, _item('Kolhapuri Pav Bhaji', price: 160)];
      final r = VoiceOrderService.parse('amol pav bhaji', only);
      expect(r.lines.single.name, 'Kolhapuri Pav Bhaji');
      expect(r.lines.single.confident, isFalse,
          reason: 'the word that names the dish was NOT heard on the menu');
    });

    test('a short distinguishing word survives one mis-heard letter', () {
      final indian = <MenuItem>[
        _item('Aloo Gobi', price: 180),
        _item('Aloo Paratha', price: 70),
        _item('Corn Palak', price: 190),
      ];
      // "gobhi" is how the recogniser spells it about half the time.
      final r = VoiceOrderService.parse('do aloo gobhi', indian);
      expect(r.lines.single.name, 'Aloo Gobi');
      expect(r.lines.single.qty, 2);
      expect(r.lines.single.confident, isTrue);
      expect(r.lines.single.ambiguous, isFalse,
          reason: '"gobhi" separates it from Aloo Paratha outright');
    });
  });

  // The risk the IDF weighting introduces: rare words now carry most of the
  // score, so a good full match must not be dragged down by the same maths
  // that sinks a bad partial one.
  group('weighting must not punish a genuinely good match', () {
    final bhajiMenu = <MenuItem>[
      ...menu,
      _item('Amul Pav Bhaji', price: 140),
      _item('Kolhapuri Pav Bhaji', price: 160),
      _item('Cheese Pav Bhaji', price: 150),
      _item('Jain Pav Bhaji', price: 140),
    ];

    test('an exact name stays confident even on a menu full of near-twins', () {
      final r = VoiceOrderService.parse('two kolhapuri pav bhaji', bhajiMenu);
      expect(r.lines.single.name, 'Kolhapuri Pav Bhaji');
      expect(r.lines.single.qty, 2);
      expect(r.lines.single.confident, isTrue);
      expect(r.lines.single.ambiguous, isFalse);
    });

    test('one typo in the discriminating word stays confident', () {
      // "cheeze" for Cheese, "panner" for Paneer — a single mis-heard letter
      // on the word that identifies the dish must still land it.
      final a = VoiceOrderService.parse('cheeze pav bhaji', bhajiMenu);
      expect(a.lines.single.name, 'Cheese Pav Bhaji');
      expect(a.lines.single.confident, isTrue);

      final b = VoiceOrderService.parse('panner tikka', bhajiMenu);
      expect(b.lines.single.name, 'Paneer Tikka');
      expect(b.lines.single.confident, isTrue);
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
