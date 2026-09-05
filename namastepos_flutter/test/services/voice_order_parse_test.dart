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

  // ── Follow-up 1: filler words ───────────────────────────────────────────
  //
  // The IDF weighting fixed the wrong-bhaji bug but taxed ordinary speech,
  // because a token on no menu row carries the HIGHEST weight as a miss —
  // right for a mis-heard dish word, wrong for "bhai". Measured before the
  // stopword list went in:
  //     "ek butter naan dena bhai"  -> 0.437  (was 0.500 pre-IDF)
  //     "two masala dosa please"    -> 0.586  (was 0.667 pre-IDF)
  // Both cleared the 0.34 floor, neither cleared the 0.72 confidence bar, so
  // an owner who speaks in sentences got every line flagged as a guess.
  group('filler words must not cost score', () {
    test('"ek butter naan dena bhai" is an exact match once filler is gone', () {
      final r = VoiceOrderService.parse('ek butter naan dena bhai', menu);
      final line = r.lines.single;
      expect(line.name, 'Butter Naan');
      expect(line.qty, 1);
      expect(line.score, greaterThan(0.9),
          reason: 'was 0.437 — the politeness must be free, not taxed');
      expect(line.confident, isTrue);
      expect(r.unmatched, isEmpty,
          reason: '"dena"/"bhai" are not dishes we failed to find');
    });

    test('"two masala dosa please" is an exact match once filler is gone', () {
      final r = VoiceOrderService.parse('two masala dosa please', menu);
      final line = r.lines.single;
      expect(line.name, 'Masala Dosa');
      expect(line.qty, 2);
      expect(line.score, greaterThan(0.9), reason: 'was 0.586');
      expect(line.confident, isTrue);
    });

    test('a whole sentence of English carrier words still finds the dish', () {
      final r = VoiceOrderService.parse(
          'can i get two paneer tikka please boss', menu);
      expect(r.lines.single.name, 'Paneer Tikka');
      expect(r.lines.single.qty, 2);
      expect(r.lines.single.confident, isTrue);
    });

    test('filler does not stop two lines being told apart', () {
      final r = VoiceOrderService.parse(
          'bhai ek masala chai dena aur do butter naan de do', menu);
      expect(r.lines.map((l) => '${l.qty}x${l.name}').toList(),
          ['1xMasala Chai', '2xButter Naan']);
    });

    test('an utterance that is nothing but politeness is not a failed order',
        () {
      final r = VoiceOrderService.parse('haan bhai please', menu);
      expect(r.lines, isEmpty);
      expect(r.unmatched, isEmpty);
    });
  });

  // `ek` is the ambiguous one: filler-shaped in "ek chai dena", but it MEANS
  // one. It is kept out of the stopword list entirely and every stopword is
  // additionally checked against the number words before it is dropped, so no
  // entry — now or one the founder adds later — can delete a count.
  group('filler stripping must never destroy a quantity', () {
    test('"ek chai" still orders exactly one chai', () {
      final r = VoiceOrderService.parse('ek chai', menu);
      expect(r.lines.single.name, 'Masala Chai');
      expect(r.lines.single.qty, 1);
    });

    test('"ek chai dena bhai" still orders exactly one chai', () {
      final r = VoiceOrderService.parse('ek chai dena bhai', menu);
      expect(r.lines.single.qty, 1);
    });

    test('"do" survives every filler word around it', () {
      expect(VoiceOrderService.parse('do masala chai dena', menu).lines.single.qty, 2);
      expect(VoiceOrderService.parse('bhai do masala chai', menu).lines.single.qty, 2);
      expect(
          VoiceOrderService.parse('masala chai do dena', menu).lines.single.qty, 2,
          reason: 'filler comes off BEFORE the trailing quantity is read');
    });

    test('"de do" is the verb "give", not the number two', () {
      final one = VoiceOrderService.parse('masala chai de do', menu);
      expect(one.lines.single.qty, 1,
          reason: '"chai de do" is "give me tea", not "tea, two"');

      final two = VoiceOrderService.parse('do masala chai de do', menu);
      expect(two.lines.single.qty, 2,
          reason: 'the real count in front must survive the verb behind');
    });

    test('a filler word that is also a menu word loses to the menu', () {
      // "wala" is filler ("chai wala do"), and it is also on this board.
      final board = <MenuItem>[
        _item('Chai Wala Special', price: 45),
        _item('Butter Naan', price: 40),
      ];
      final r = VoiceOrderService.parse('do chai wala special', board);
      expect(r.lines.single.name, 'Chai Wala Special');
      expect(r.lines.single.qty, 2);
      expect(r.lines.single.confident, isTrue);

      // Same word, a menu that does NOT sell it: now it is filler again.
      final plain = VoiceOrderService.parse('do chai wala', menu);
      expect(plain.lines.single.name, 'Masala Chai');
      expect(plain.lines.single.qty, 2);
    });
  });

  // ── Follow-up 2: transliteration aliases ────────────────────────────────
  //
  // "alu" could never reach "aloo": the fuzzy rule needs four characters and
  // "alu" is three, and dropping the bound to three makes edit distance stop
  // discriminating. Aliases are the fix — one canonical spelling applied to
  // BOTH sides before anything is compared.
  group('transliteration aliases', () {
    final indian = <MenuItem>[
      _item('Aloo Paratha', price: 70),
      _item('Aloo Gobi', price: 180),
      _item('Paneer Tikka', price: 250),
      _item('Masala Chai', price: 30),
    ];

    test('"alu paratha" matches Aloo Paratha', () {
      final r = VoiceOrderService.parse('do alu paratha', indian);
      expect(r.lines.single.name, 'Aloo Paratha');
      expect(r.lines.single.qty, 2);
      expect(r.lines.single.confident, isTrue);
      expect(r.lines.single.ambiguous, isFalse);
    });

    test('every common spelling of aloo reaches the same dish', () {
      for (final said in ['alu', 'aalu', 'aaloo', 'allu', 'aloo']) {
        final r = VoiceOrderService.parse('$said paratha', indian);
        expect(r.lines.single.name, 'Aloo Paratha', reason: 'said "$said"');
      }
    });

    test('gobi and gobhi are the same word in both directions', () {
      expect(VoiceOrderService.parse('aloo gobhi', indian).lines.single.name,
          'Aloo Gobi');
      // ...and a menu spelled the other way must accept the plain spelling.
      final other = <MenuItem>[_item('Alu Gobhi', price: 180), ...menu];
      expect(VoiceOrderService.parse('aloo gobi', other).lines.single.name,
          'Alu Gobhi');
    });

    test('a three-letter alias works where fuzzy matching cannot', () {
      // "pav"/"paav"/"pao" are all three or four letters; edit distance is
      // not allowed to touch them, so only the table can join them.
      final board = <MenuItem>[
        _item('Vada Pav', price: 25),
        _item('Misal Pav', price: 90),
      ];
      expect(VoiceOrderService.parse('wada paav', board).lines.single.name,
          'Vada Pav');
      expect(VoiceOrderService.parse('missal pao', board).lines.single.name,
          'Misal Pav');
    });

    test('canonicalisation is applied to the menu side too', () {
      expect(VoiceOrderService.canonical('Alu Gobhi'), 'aloo gobi');
      expect(VoiceOrderService.canonical('Aaloo Gobi'), 'aloo gobi');
      expect(VoiceOrderService.canonical('Chhole Bhature'), 'chole bhature');
      expect(VoiceOrderService.canonical('Panner Tikka'), 'paneer tikka');
    });

    test('no alias is listed twice, and none is also a canonical form', () {
      final table = VoiceOrderService.aliasTable;
      final canonicals = table.values.toSet();
      for (final variant in table.keys) {
        expect(canonicals.contains(variant), isFalse,
            reason: '"$variant" is both a variant and a canonical form, so '
                'folding would depend on the order of the table');
      }
    });
  });

  // THE risk aliasing introduces: collapse two dishes onto one string and the
  // wrong item goes on a real customer's bill. This is the guard.
  group('canonicalisation must never merge two different dishes', () {
    // A realistic north-Indian / Maharashtrian / South-Indian board, chosen
    // to carry every look-alike pair the alias table could plausibly have
    // merged.
    final realistic = <String>[
      'Aloo Paratha', 'Lachha Paratha', 'Malabar Parotta', 'Tandoori Roti',
      'Rumali Roti', 'Butter Naan', 'Garlic Naan', 'Amritsari Kulcha',
      'Aloo Gobi', 'Aloo Tikki', 'Paneer Tikka', 'Kadai Paneer',
      'Punjabi Kadhi', 'Malai Kofta', 'Kaju Curry', 'Dal Tadka',
      'Dal Makhani', 'Chana Masala', 'Chole Bhature', 'Rajma Chawal',
      'Veg Biryani', 'Veg Pulao', 'Jeera Rice', 'Kheera Raita',
      'Dahi Vada', 'Curd Rice', 'Vada Pav', 'Batata Vada', 'Medu Vada',
      'Pav Bhaji', 'Kanda Bhaji', 'Batata Bhaji', 'Misal Pav', 'Usal Pav',
      'Masala Dosa', 'Rava Dosa', 'Idli Sambar', 'Rasam Rice',
      'Soya Chaap', 'Papdi Chaat', 'Sev Puri', 'Bhel Puri', 'Pani Puri',
      'Paneer Bhurji', 'Egg Bhurji', 'Chicken Keema', 'Mutton Korma',
      'Gulab Jamun', 'Rasgulla', 'Kheer', 'Shrikhand', 'Kulfi Falooda',
      'Masala Chai', 'Sweet Lassi', 'Cold Coffee', 'Fresh Lime Soda',
      'Veg Manchurian', 'Schezwan Noodles', 'Veg Thali', 'Thai Green Curry',
    ];

    test('no two menu items canonicalise to the same string', () {
      final seen = <String, String>{};
      for (final name in realistic) {
        final key = VoiceOrderService.canonical(name);
        expect(seen.containsKey(key), isFalse,
            reason: '"$name" and "${seen[key]}" both canonicalise to "$key" — '
                'the wrong one would land on a customer\'s bill');
        seen[key] = name;
      }
      expect(seen.length, realistic.length);
    });

    test('look-alikes that are different dishes stay apart when spoken', () {
      final board = realistic.map(_item).toList();

      // Aliasing keeps them distinct; the fuzzy rule must not put them back
      // together — "tikka"/"tikki" are one edit apart.
      expect(VoiceOrderService.parse('paneer tikka', board).lines.single.name,
          'Paneer Tikka');
      expect(VoiceOrderService.parse('aloo tikki', board).lines.single.name,
          'Aloo Tikki');
      expect(VoiceOrderService.parse('kadai paneer', board).lines.single.name,
          'Kadai Paneer');
      expect(VoiceOrderService.parse('punjabi kadhi', board).lines.single.name,
          'Punjabi Kadhi');
      expect(VoiceOrderService.parse('jeera rice', board).lines.single.name,
          'Jeera Rice');
      expect(VoiceOrderService.parse('kheera raita', board).lines.single.name,
          'Kheera Raita');
      expect(VoiceOrderService.parse('soya chaap', board).lines.single.name,
          'Soya Chaap');
      expect(VoiceOrderService.parse('papdi chaat', board).lines.single.name,
          'Papdi Chaat');
      expect(VoiceOrderService.parse('veg pulao', board).lines.single.name,
          'Veg Pulao');
      expect(VoiceOrderService.parse('veg biryani', board).lines.single.name,
          'Veg Biryani');
    });

    test('a two-item board of pure look-alikes does not cross over', () {
      final pair = <MenuItem>[
        _item('Paneer Tikka', price: 250),
        _item('Aloo Tikki', price: 60),
      ];
      final a = VoiceOrderService.parse('do paneer tikka', pair);
      expect(a.lines.single.name, 'Paneer Tikka');
      expect(a.lines.single.qty, 2);

      final b = VoiceOrderService.parse('teen aloo tikki', pair);
      expect(b.lines.single.name, 'Aloo Tikki');
      expect(b.lines.single.qty, 3);
    });

    test('the bare word alone does not cross over either', () {
      // This is what the never-fuzzy guard is FOR. "tikka" and "tikki" are one
      // edit apart, so without it a lone "tikki" scores 0.5 against BOTH rows,
      // ties, and hands back Paneer Tikka — the ₹250 line — as the head guess
      // for a ₹60 order.
      final pair = <MenuItem>[
        _item('Paneer Tikka', price: 250),
        _item('Aloo Tikki', price: 60),
      ];
      final r = VoiceOrderService.parse('do tikki', pair);
      expect(r.lines.single.name, 'Aloo Tikki');
      expect(r.lines.single.ambiguous, isFalse);
      expect(r.lines.single.qty, 2);
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
