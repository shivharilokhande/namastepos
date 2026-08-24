// NamastePOS — Voice ordering (G9) — STUB.
//
// speech_to_text 6.x conflicts with our connectivity_plus 5.x via a js
// transitive dep mismatch. Until we bump connectivity_plus we keep this
// file as a no-op stub so the rest of the app compiles. The `parse()`
// helper is pure-Dart and stays useful — wire it up to whatever real
// speech source we land on (Apple's SFSpeechRecognizer, Android's
// SpeechRecognizer, or a Whisper API).

import '../models/menu_item.dart';

class ParsedVoiceLine {
  final String name;
  final int qty;
  ParsedVoiceLine(this.name, this.qty);
}

class VoiceOrderService {
  VoiceOrderService._();
  static final VoiceOrderService instance = VoiceOrderService._();

  bool get available => false;

  Future<bool> init() async => false;

  /// Always returns null in stub mode — caller surfaces a "voice disabled"
  /// hint to the user.
  Future<String?> listen({Duration timeout = const Duration(seconds: 5)}) async => null;

  /// Parses "two paneer tikka, one naan, three coke" against the live
  /// menu and returns line items + qty. Unmatched names are dropped.
  static List<ParsedVoiceLine> parse(String text, List<MenuItem> menu) {
    if (text.trim().isEmpty) return const [];
    const wordNums = {
      'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
      'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
      'a': 1, 'an': 1, 'half': 1,
    };
    final cleaned = text.toLowerCase().replaceAll(',', ' and ');
    final chunks = cleaned.split(RegExp(r'\s+and\s+|\s+with\s+|\s+plus\s+'));
    final out = <ParsedVoiceLine>[];
    for (final raw in chunks) {
      final parts = raw.trim().split(RegExp(r'\s+'));
      if (parts.isEmpty) continue;
      int qty = 1;
      int i = 0;
      final lead = parts[i];
      final parsed = int.tryParse(lead);
      if (parsed != null) { qty = parsed; i++; }
      else if (wordNums.containsKey(lead)) { qty = wordNums[lead]!; i++; }
      final name = parts.sublist(i).join(' ').trim();
      if (name.isEmpty) continue;
      MenuItem? match;
      for (final m in menu) {
        if (m.name.toLowerCase() == name) { match = m; break; }
      }
      match ??= menu.where((m) =>
          m.name.toLowerCase().contains(name) ||
          name.contains(m.name.toLowerCase())).firstOrNull;
      if (match != null) {
        out.add(ParsedVoiceLine(match.name, qty));
      }
    }
    return out;
  }
}

extension _FirstOrNull<E> on Iterable<E> {
  E? get firstOrNull => isEmpty ? null : first;
}
