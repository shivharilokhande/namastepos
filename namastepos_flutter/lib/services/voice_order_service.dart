// NamastePOS — Voice ordering (G9). REAL implementation, 2026-09-05.
//
// HISTORY: this file used to be a no-op stub because `speech_to_text ^6.6.2`
// pinned `js ^0.7` against `connectivity_plus 5.x`'s `js ^0.6`. Both halves of
// that are now gone — connectivity_plus is ^7.3.1 and speech_to_text 7.x
// dropped package:js for dart:js_interop — so the dependency resolves clean
// and the stub is replaced by the thing it was standing in for.
//
// WHAT THIS IS
// A thin, defensive wrapper over the OS speech recognisers ONLY:
//   Android → android.speech.SpeechRecognizer
//   iOS     → Speech.framework / SFSpeechRecognizer
// There is no NamastePOS server in this path. We never record to a file, we
// never upload audio, and no transcript is persisted anywhere. Crucially,
// nothing from here is reported to analytics: lib/services/analytics_service
// .dart has a per-event property ALLOW-LIST, no voice property is on it, and
// none may be added — a transcript is a diner's words and would blow a hole
// in the DPDP console this product ships.
//
// TWO HARD DESIGN RULES
//
//  1. NEVER A DEAD BUTTON. Every failure path — no recogniser on the device,
//     permission refused, permission permanently blocked, offline, an
//     unsupported language, a busy microphone, silence — returns a specific
//     sentence an owner can act on ([lastMessage]). A device with no
//     recogniser at all is reported through [offerMicButton] == false so the
//     screen never draws the mic in the first place.
//
//  2. NEVER SILENTLY ADD TO A BILL. Speech-to-text on a mixed Hindi/Marathi/
//     English menu is not accurate enough to trust unattended (see
//     [parse] for what actually happens to "do chai"), so [parse] returns
//     matches AND misses with a score, and the caller must confirm before
//     anything reaches the cart.
//
// PROBE vs INIT — why there are two entry points:
//   [probe]  never prompts. It uses [SpeechToText.hasPermission] (documented
//            as prompt-free) and only runs a real initialize() when the mic
//            permission is ALREADY granted. Safe to call from initState.
//   [init]   is the prompting one, called on the first mic tap, where a
//            permission dialog is something the owner asked for.
// That split is what stops the app throwing an OS permission sheet at an
// owner who merely opened the New Order screen.

import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart' show debugPrint, kDebugMode;
import 'package:permission_handler/permission_handler.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:speech_to_text/speech_recognition_error.dart';
import 'package:speech_to_text/speech_to_text.dart' as stt;

import '../models/menu_item.dart';

/// Why voice is (or is not) usable on THIS device, right now.
enum VoiceReadiness {
  /// Not probed yet.
  unknown,

  /// A recogniser exists and permission is granted — [listen] will work.
  ready,

  /// Plausibly fine, but the owner has not been asked for the microphone
  /// yet. The button is offered; the first tap asks.
  needsPermission,

  /// Permission was refused permanently (or is restricted by MDM/parental
  /// controls). Only the OS Settings app can undo this.
  permissionBlocked,

  /// The device genuinely has no speech recogniser (common on ROMs shipped
  /// without Google's app). The mic button is not offered at all.
  noRecognizer,

  /// Desktop/web/test — this build has no voice path.
  unsupportedPlatform,
}

/// A recognition language the device actually supports, in the device's own
/// spelling (`en_IN` on Android, `en-IN` on iOS).
class VoiceLocale {
  final String id;
  final String name;
  const VoiceLocale(this.id, this.name);
}

/// One recognised "N × item" line, plus how sure the match is.
class ParsedVoiceLine {
  final String name;
  final int qty;

  /// The menu row this matched. Null only when constructed by hand.
  final MenuItem? item;

  /// 0..1. 1.0 is an exact name match; anything under
  /// [VoiceOrderService.confidentMatch] should be shown to the owner as a
  /// guess, not a fact.
  final double score;

  /// What the owner actually said for this line, kept so the confirm sheet
  /// can show "you said X, I think you meant Y".
  final String spoken;

  ParsedVoiceLine(this.name, this.qty,
      {this.item, this.score = 1.0, this.spoken = ''});

  bool get confident => score >= VoiceOrderService.confidentMatch;
}

/// The whole of what one utterance produced. Misses are returned, never
/// dropped — an owner who said three things and got two needs to be told.
class VoiceParseResult {
  final List<ParsedVoiceLine> lines;
  final List<String> unmatched;

  const VoiceParseResult(this.lines, this.unmatched);

  static const empty = VoiceParseResult(<ParsedVoiceLine>[], <String>[]);

  bool get isEmpty => lines.isEmpty && unmatched.isEmpty;
}

class VoiceOrderService {
  VoiceOrderService._();
  static final VoiceOrderService instance = VoiceOrderService._();

  /// Below this, a match is a suggestion and is flagged as such in the UI.
  static const double confidentMatch = 0.72;

  /// The default recognition language. en_IN — NOT hi_IN — on purpose:
  /// menus in this app are stored in Latin script, and an hi_IN recogniser
  /// returns Devanagari ("दो चाय"), which cannot match a row called "Masala
  /// Chai". en_IN is trained on Indian-accented English and passes most
  /// food-hall Hinglish through in Latin script, which is what the matcher
  /// downstream can actually work with. Owners who want a different one can
  /// change it — see [setLocale].
  static const String defaultLocaleId = 'en_IN';

  static const _kNoRecognizer = 'np_voice_no_recognizer_v1';
  static const _kLocale = 'np_voice_locale_v1';

  final stt.SpeechToText _speech = stt.SpeechToText();

  VoiceReadiness _readiness = VoiceReadiness.unknown;
  String _lastMessage = '';
  String? _localeId;
  List<stt.LocaleName> _locales = const <stt.LocaleName>[];
  Completer<String?>? _session;
  Timer? _guard;

  // ── State the UI reads ────────────────────────────────────────────────────

  VoiceReadiness get readiness => _readiness;

  /// Kept from the stub's contract. True only when a listen would actually
  /// start right now.
  bool get available => _readiness == VoiceReadiness.ready;

  /// Whether to DRAW the mic button. False for a device with no recogniser
  /// and for unsupported platforms: rule 1 says an owner should never be
  /// offered a control that cannot work. `permissionBlocked` still shows the
  /// button because tapping it opens Settings, which is a real way forward.
  bool get offerMicButton =>
      _readiness == VoiceReadiness.ready ||
      _readiness == VoiceReadiness.needsPermission ||
      _readiness == VoiceReadiness.permissionBlocked;

  /// True when the only thing standing between the owner and Settings is the
  /// OS. Lets the caller attach an "Open settings" action to its snackbar.
  bool get needsSettings => _readiness == VoiceReadiness.permissionBlocked;

  /// A plain-English (short, owner-facing) explanation of the last failure.
  /// Empty when the last call succeeded.
  String get lastMessage => _lastMessage;

  /// The recognition language in force, e.g. 'en_IN'. Null before [probe].
  String? get localeId => _localeId;

  /// Languages this device can recognise that are worth offering an Indian
  /// restaurant: everything region-India, plus any English. Empty until a
  /// successful initialize. Returned as [VoiceLocale] rather than the
  /// plugin's own type so screens never import speech_to_text.
  List<VoiceLocale> get selectableLocales {
    final out = _locales
        .where((l) {
          final id = _norm(l.localeId);
          return id.endsWith('_in') || id.startsWith('en_') || id == 'en';
        })
        .map((l) => VoiceLocale(l.localeId, l.name))
        .toList();
    out.sort((a, b) {
      // en_IN first — it is the default and the one most likely to work.
      final ai = _norm(a.id) == 'en_in' ? 0 : 1;
      final bi = _norm(b.id) == 'en_in' ? 0 : 1;
      if (ai != bi) return ai - bi;
      return a.name.compareTo(b.name);
    });
    return out;
  }

  static bool get _isMobile {
    if (Platform.environment.containsKey('FLUTTER_TEST')) return false;
    return Platform.isAndroid || Platform.isIOS;
  }

  // ── Readiness ─────────────────────────────────────────────────────────────

  /// Non-prompting readiness check. Safe from initState / build-time.
  Future<VoiceReadiness> probe() async {
    if (!_isMobile) return _readiness = VoiceReadiness.unsupportedPlatform;
    if (_readiness == VoiceReadiness.ready) return _readiness;

    final perm = await _permission();
    if (perm == _Perm.blocked) return _readiness = VoiceReadiness.permissionBlocked;
    if (perm == _Perm.notAsked) {
      // We cannot learn whether a recogniser exists without initialize(),
      // and initialize() prompts. If a PREVIOUS prompt already proved this
      // device has none, honour that and stay hidden; otherwise offer the
      // button and find out on the first tap.
      final none = await _flag(_kNoRecognizer);
      return _readiness =
          none ? VoiceReadiness.noRecognizer : VoiceReadiness.needsPermission;
    }
    // Permission granted ⇒ initialize() cannot raise a dialog. Probe for real.
    return _initialise();
  }

  /// Prompting init. Returns true when [listen] can run. Kept from the stub's
  /// contract (`Future<bool> init()`).
  Future<bool> init() async {
    if (!_isMobile) {
      _readiness = VoiceReadiness.unsupportedPlatform;
      return false;
    }
    if (_readiness == VoiceReadiness.ready) return true;
    return (await _initialise()) == VoiceReadiness.ready;
  }

  Future<VoiceReadiness> _initialise() async {
    bool ok = false;
    try {
      ok = await _speech.initialize(
        onError: _onError,
        onStatus: _onStatus,
        debugLogging: false,
      );
    } catch (e) {
      // A missing native recogniser can throw rather than return false.
      if (kDebugMode) debugPrint('[voice] initialize failed: $e');
      ok = false;
    }

    if (!ok) {
      // initialize() returns false for BOTH "no permission" and "no
      // recogniser", which are completely different problems for the owner.
      // Ask the permission layer which one it was.
      final perm = await _permission();
      if (perm == _Perm.blocked) {
        return _readiness = VoiceReadiness.permissionBlocked;
      }
      if (perm == _Perm.notAsked) {
        return _readiness = VoiceReadiness.needsPermission;
      }
      // Permission is granted and it still failed ⇒ the device has no
      // recogniser. Remember it so the button stops being drawn.
      await _setFlag(_kNoRecognizer, true);
      return _readiness = VoiceReadiness.noRecognizer;
    }

    await _setFlag(_kNoRecognizer, false);
    await _resolveLocale();
    return _readiness = VoiceReadiness.ready;
  }

  // ── Listening ─────────────────────────────────────────────────────────────

  /// Listen once and return the final transcript, or null.
  ///
  /// Null ALWAYS comes with a reason in [lastMessage] — silence, offline, a
  /// refused permission, an unsupported language. Never returns a partial.
  Future<String?> listen({
    Duration timeout = const Duration(seconds: 8),
    String? localeId,
  }) async {
    _lastMessage = '';
    if (!await init()) {
      _lastMessage = messageForReadiness(_readiness);
      return null;
    }

    // A previous session that never got its final result would swallow this
    // one's callbacks.
    if (_speech.isListening) {
      try {
        await _speech.cancel();
      } catch (_) { /* already dead */ }
    }
    _finish(null);

    final completer = Completer<String?>();
    _session = completer;
    var best = '';

    // pauseFor is what actually ends a normal utterance; listenFor is the
    // hard ceiling. Android imposes its own 1–3s floor on pauseFor that we
    // cannot go under, hence the clamp rather than something tighter.
    final pause = timeout < const Duration(seconds: 4)
        ? timeout
        : const Duration(seconds: 3);

    try {
      await _speech.listen(
        onResult: (result) {
          final words = result.recognizedWords.trim();
          if (words.isNotEmpty) best = words;
          if (result.finalResult) _finish(best);
        },
        listenOptions: stt.SpeechListenOptions(
          localeId: localeId ?? _localeId ?? defaultLocaleId,
          partialResults: true,
          // Permanent errors must tear the session down themselves, or the
          // mic stays hot after a failure.
          cancelOnError: true,
          // An order is a short phrase, not a paragraph. iOS-only hint.
          listenMode: stt.ListenMode.confirmation,
          listenFor: timeout,
          pauseFor: pause,
        ),
      );
    } catch (e) {
      if (kDebugMode) debugPrint('[voice] listen failed: $e');
      _session = null;
      _lastMessage =
          'Could not start the microphone. Close any call or recording and try again.';
      return null;
    }

    // Belt to the plugin's braces: if neither a final result nor an error
    // ever arrives (seen on some Android ROMs), stop and take what we have.
    _guard = Timer(timeout + const Duration(seconds: 3), () async {
      try {
        await _speech.stop();
      } catch (_) { /* ignore */ }
      _finish(best);
    });

    final text = await completer.future;
    _guard?.cancel();
    _guard = null;
    _session = null;

    if (text == null || text.trim().isEmpty) {
      if (_lastMessage.isEmpty) {
        _lastMessage = 'Did not catch that. Hold the phone closer and say the '
            'quantity then the item, like "do chai".';
      }
      return null;
    }
    return text.trim();
  }

  /// Stop any in-flight session. Call from the screen's dispose().
  Future<void> abort() async {
    _guard?.cancel();
    _guard = null;
    try {
      if (_speech.isListening) await _speech.cancel();
    } catch (_) { /* ignore */ }
    _finish(null);
  }

  void _finish(String? value) {
    final c = _session;
    if (c == null || c.isCompleted) return;
    c.complete(value);
  }

  void _onStatus(String status) {
    // 'done' / 'notListening' with nothing delivered means silence. The
    // result callback has already fired for anything real.
    if (status == 'done' || status == 'notListening') {
      final c = _session;
      if (c != null && !c.isCompleted) {
        // Give a final result that is already in flight one turn to land.
        Future<void>.delayed(const Duration(milliseconds: 400), () {
          if (identical(_session, c)) _finish(null);
        });
      }
    }
  }

  void _onError(SpeechRecognitionError error) {
    _lastMessage = _messageForError(error.errorMsg);
    if (error.errorMsg.contains('permission')) {
      _readiness = VoiceReadiness.permissionBlocked;
    }
    _finish(null);
  }

  /// Maps the recogniser's machine error codes (Android's `error_*` set and
  /// iOS's equivalents) onto something a restaurant owner can act on.
  static String _messageForError(String code) {
    final c = code.toLowerCase();
    if (c.contains('permission') || c.contains('denied')) {
      return 'Microphone permission is off. Turn it on for NamastePOS in your '
          'phone Settings, then try again.';
    }
    if (c.contains('network')) {
      return 'Voice needs internet on this phone (or a downloaded offline '
          'language pack). You are offline — add the items from the menu grid.';
    }
    if (c.contains('no_match') || c.contains('speech_timeout')) {
      return 'Did not catch that. Say the quantity then the item, like '
          '"do chai" or "two masala dosa".';
    }
    if (c.contains('language')) {
      return 'This phone cannot recognise the selected language yet. Long-press '
          'the mic to pick another one.';
    }
    if (c.contains('busy')) {
      return 'The microphone is busy. End any call or recording and try again.';
    }
    if (c.contains('audio') || c.contains('client')) {
      return 'Could not read the microphone. Check that nothing is covering it '
          'and try again.';
    }
    if (c.contains('server')) {
      return 'The speech service did not answer. Try again, or add the items '
          'from the menu grid.';
    }
    return 'Voice input failed on this phone. Add the items from the menu grid.';
  }

  /// Owner-facing sentence for a readiness state. Public so the caller can
  /// explain a hidden/blocked button without duplicating the wording.
  static String messageForReadiness(VoiceReadiness r) {
    switch (r) {
      case VoiceReadiness.ready:
        return '';
      case VoiceReadiness.needsPermission:
        return 'NamastePOS needs microphone permission to take voice orders.';
      case VoiceReadiness.permissionBlocked:
        return 'Microphone permission is blocked. Turn it on for NamastePOS in '
            'phone Settings to use voice orders.';
      case VoiceReadiness.noRecognizer:
        return 'This phone has no speech recognition service, so voice orders '
            'are not available on it.';
      case VoiceReadiness.unsupportedPlatform:
        return 'Voice orders work on the Android and iPhone apps.';
      case VoiceReadiness.unknown:
        return 'Voice orders are not ready yet.';
    }
  }

  // ── Language ──────────────────────────────────────────────────────────────

  Future<void> _resolveLocale() async {
    try {
      _locales = await _speech.locales();
    } catch (_) {
      _locales = const <stt.LocaleName>[];
    }
    final ids = _locales.map((l) => _norm(l.localeId)).toList();
    bool has(String want) => ids.isEmpty || ids.contains(_norm(want));

    final saved = await _savedLocale();
    if (saved != null && has(saved)) {
      _localeId = _exact(saved) ?? saved;
      return;
    }
    if (has(defaultLocaleId)) {
      _localeId = _exact(defaultLocaleId) ?? defaultLocaleId;
      return;
    }
    // No en_IN on this device — fall back to whatever the phone itself is set
    // to before guessing, since that is the language its owner uses.
    try {
      final sys = await _speech.systemLocale();
      if (sys != null) {
        _localeId = sys.localeId;
        return;
      }
    } catch (_) { /* fall through */ }
    if (has('en_US')) {
      _localeId = _exact('en_US') ?? 'en_US';
      return;
    }
    _localeId = _locales.isNotEmpty ? _locales.first.localeId : defaultLocaleId;
  }

  /// Device ids differ in separator (`en_IN` on Android, `en-IN` on iOS), so
  /// match loosely and hand back the device's own spelling.
  String? _exact(String want) {
    final w = _norm(want);
    for (final l in _locales) {
      if (_norm(l.localeId) == w) return l.localeId;
    }
    return null;
  }

  static String _norm(String id) => id.toLowerCase().replaceAll('-', '_');

  /// Change the recognition language and remember it for next time.
  Future<void> setLocale(String id) async {
    _localeId = id;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_kLocale, id);
    } catch (_) { /* storage unavailable — applies to this session only */ }
  }

  Future<String?> _savedLocale() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final v = prefs.getString(_kLocale);
      return (v == null || v.isEmpty) ? null : v;
    } catch (_) {
      return null;
    }
  }

  // ── Permission ────────────────────────────────────────────────────────────

  Future<_Perm> _permission() async {
    try {
      // speech_to_text's own check is documented as prompt-free and reflects
      // what the plugin itself will see.
      if (await _speech.hasPermission) return _Perm.granted;
    } catch (_) { /* fall through to permission_handler */ }
    try {
      final mic = await Permission.microphone.status;
      if (mic.isPermanentlyDenied || mic.isRestricted) return _Perm.blocked;
      if (Platform.isIOS) {
        // iOS gates dictation behind a SECOND grant (SFSpeechRecognizer), so
        // a granted microphone alone is not enough.
        final speech = await Permission.speech.status;
        if (speech.isPermanentlyDenied || speech.isRestricted) {
          return _Perm.blocked;
        }
        if (!mic.isGranted || !speech.isGranted) return _Perm.notAsked;
        return _Perm.granted;
      }
      return mic.isGranted ? _Perm.granted : _Perm.notAsked;
    } catch (_) {
      return _Perm.notAsked;
    }
  }

  /// Open the OS settings page for this app. For [needsSettings].
  Future<void> openSettings() async {
    try {
      await openAppSettings();
    } catch (_) { /* nothing else we can do */ }
  }

  // ── Small prefs helpers ───────────────────────────────────────────────────

  Future<bool> _flag(String key) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      return prefs.getBool(key) ?? false;
    } catch (_) {
      return false;
    }
  }

  Future<void> _setFlag(String key, bool value) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setBool(key, value);
    } catch (_) { /* storage unavailable */ }
  }

  // ══ Parsing ═══════════════════════════════════════════════════════════════
  //
  // Pure Dart, no plugin, unit-tested (test/services/voice_order_parse_test
  // .dart). This is deliberately the ONLY clever part of the feature, and it
  // is still not clever enough to trust unattended — see the class doc.

  /// Leading (or trailing) quantity words. English plus the Latin
  /// transliterations an en_IN recogniser actually emits for Hindi/Marathi
  /// counting, plus Devanagari for the times it does not transliterate.
  ///
  /// DELIBERATELY ABSENT: 'che'. It is a plausible spelling of छह (6) but it
  /// is also a Marathi possessive particle and a substring of real menu
  /// words, and mis-reading it as a quantity would silently multiply a bill.
  /// 'chai' is a drink and is never a number here.
  static const Map<String, int> _numWords = {
    // English
    'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'six': 6,
    'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10, 'eleven': 11, 'twelve': 12,
    'a': 1, 'an': 1, 'half': 1, 'single': 1, 'double': 2, 'couple': 2,
    'dozen': 12,
    // Hindi / Marathi in Latin script
    'ek': 1, 'eak': 1, 'aik': 1, 'ik': 1,
    'do': 2, 'doh': 2, 'don': 2, 'dho': 2,
    'teen': 3, 'tin': 3, 'theen': 3,
    'char': 4, 'chaar': 4,
    'panch': 5, 'paanch': 5, 'panj': 5,
    'chhe': 6, 'chah': 6, 'chhah': 6, 'saha': 6,
    'saat': 7, 'sat': 7,
    'aath': 8, 'aat': 8,
    'nau': 9, 'nao': 9,
    'das': 10, 'dus': 10, 'dah': 10,
    'gyarah': 11, 'barah': 12, 'bara': 12,
    // Devanagari
    'एक': 1, 'दो': 2, 'दोन': 2, 'तीन': 3, 'चार': 4, 'पांच': 5, 'पाँच': 5,
    'छह': 6, 'सहा': 6, 'सात': 7, 'आठ': 8, 'नौ': 9, 'नऊ': 9, 'दस': 10,
  };

  /// Counting nouns that sit between the number and the dish and mean
  /// nothing to the matcher: "do plate dosa", "ek cup chai".
  static const Set<String> _unitWords = {
    'plate', 'plates', 'piece', 'pieces', 'pcs', 'pc', 'nos', 'no',
    'order', 'orders', 'portion', 'portions', 'cup', 'cups', 'glass',
    'glasses', 'thali', 'thalis', 'ka', 'ki', 'ke',
  };

  static const Map<String, String> _devanagariDigits = {
    '०': '0', '१': '1', '२': '2', '३': '3', '४': '4',
    '५': '5', '६': '6', '७': '7', '८': '8', '९': '9',
  };

  /// Splits an utterance into "N × dish" lines against the live menu.
  ///
  /// Handles the quantity leading ("two paneer tikka", "do chai") AND
  /// trailing ("chai do", "masala dosa 2"), because Hindi word order puts it
  /// in both places. Returns misses as well as hits — the caller must show
  /// both and get a confirmation before touching the cart.
  static VoiceParseResult parse(String text, List<MenuItem> menu) {
    if (text.trim().isEmpty) return VoiceParseResult.empty;

    var cleaned = text.toLowerCase();
    _devanagariDigits.forEach((k, v) => cleaned = cleaned.replaceAll(k, v));
    cleaned = cleaned
        .replaceAll(RegExp(r'[,;।|/]'), ' and ')
        .replaceAll(RegExp(r'[^\w\sऀ-ॿ]'), ' ');

    // Conjunctions, in the three languages an owner mixes freely.
    final chunks = cleaned.split(
        RegExp(r'\s+(?:and|aur|और|ani|आणि|plus|with|then|also)\s+'));

    final lines = <ParsedVoiceLine>[];
    final unmatched = <String>[];

    for (final raw in chunks) {
      final spoken = raw.trim();
      if (spoken.isEmpty) continue;
      var parts = spoken.split(RegExp(r'\s+')).where((p) => p.isNotEmpty).toList();
      if (parts.isEmpty) continue;

      var qty = 1;
      var sawQty = false;

      // Leading quantity.
      final lead = parts.first;
      final leadNum = int.tryParse(lead);
      if (leadNum != null && leadNum > 0) {
        qty = leadNum;
        sawQty = true;
        parts = parts.sublist(1);
      } else if (_numWords.containsKey(lead)) {
        qty = _numWords[lead]!;
        sawQty = true;
        parts = parts.sublist(1);
      }

      // Trailing quantity ("chai do") — only when the front had none, so
      // "two dosa two" cannot be read as four.
      if (!sawQty && parts.length > 1) {
        final tail = parts.last;
        final tailNum = int.tryParse(tail);
        if (tailNum != null && tailNum > 0) {
          qty = tailNum;
          parts = parts.sublist(0, parts.length - 1);
        } else if (_numWords.containsKey(tail)) {
          qty = _numWords[tail]!;
          parts = parts.sublist(0, parts.length - 1);
        }
      }

      // Drop counting nouns, but never the whole phrase — "do plate" with no
      // dish is a miss, not a plate.
      final words = parts.where((p) => !_unitWords.contains(p)).toList();
      if (words.isEmpty) continue;

      // A silly quantity is far more likely to be a misheard word than a real
      // order; clamp rather than let "hundred chai" onto a bill.
      if (qty > 99) qty = 99;

      final name = words.join(' ');
      final match = _bestMatch(name, menu);
      if (match == null) {
        unmatched.add(name);
      } else {
        lines.add(ParsedVoiceLine(match.item.name, qty,
            item: match.item, score: match.score, spoken: name));
      }
    }
    return VoiceParseResult(lines, unmatched);
  }

  /// Anything at or below this is noise, not a match. An unmatched line is
  /// shown to the owner as "not on the menu"; a WRONG one lands on a real
  /// customer's bill, so the floor is deliberately not generous. 0.34 lets a
  /// single spoken word still reach a three-word dish — as a flagged guess.
  static const double _matchFloor = 0.34;

  static _Match? _bestMatch(String spoken, List<MenuItem> menu) {
    _Match? best;
    double? runnerUp;
    for (final m in menu) {
      final s = _similarity(spoken, m.name.toLowerCase());
      if (s <= 0) continue;
      if (best == null || s > best.score) {
        runnerUp = best?.score;
        best = _Match(m, s);
      } else if (runnerUp == null || s > runnerUp) {
        runnerUp = s;
      }
    }
    if (best == null || best.score < _matchFloor) return null;
    // A tie is a coin flip, not a match — "masala" fits Masala Chai and
    // Masala Dosa equally well. Cap the confidence so the confirm sheet shows
    // it as a guess and the owner actually looks at it.
    if (runnerUp != null && (best.score - runnerUp).abs() < 0.01) {
      final capped = best.score < 0.5 ? best.score : 0.5;
      return _Match(best.item, capped);
    }
    return best;
  }

  /// 0..1 similarity between a spoken phrase and a menu item name.
  ///
  /// Word overlap, NOT substring containment. Containment scores "masala"
  /// against "Masala Chai" as a near-certainty purely because six of eleven
  /// characters line up, which is how a half-heard word becomes a wrong bill.
  /// Counting whole words instead makes a one-word hit on a two-word dish
  /// score 0.5 — matched, but under [confidentMatch], so the owner is asked.
  static double _similarity(String spoken, String itemName) {
    if (spoken == itemName) return 1.0;
    final a = spoken.split(RegExp(r'\s+')).where((w) => w.isNotEmpty).toList();
    final b = itemName
        .split(RegExp(r'[\s\-_/()]+'))
        .where((w) => w.isNotEmpty)
        .toList();
    if (a.isEmpty || b.isEmpty) return 0;

    var hits = 0;
    final used = List<bool>.filled(b.length, false);
    for (final wordA in a) {
      for (var i = 0; i < b.length; i++) {
        if (used[i]) continue;
        if (_wordsMatch(wordA, b[i])) {
          used[i] = true;
          hits++;
          break;
        }
      }
    }
    if (hits == 0) return 0;
    final denom = a.length > b.length ? a.length : b.length;
    return hits / denom;
  }

  static bool _wordsMatch(String a, String b) {
    if (a == b) return true;
    if (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))) {
      return true;
    }
    // One typo/mishearing on a reasonably long word ("panner" → "paneer").
    if (a.length >= 5 && b.length >= 5 && (a.length - b.length).abs() <= 1) {
      return _editDistanceWithin1(a, b);
    }
    return false;
  }

  /// True when [a] and [b] differ by at most one insert/delete/substitute.
  /// A bounded check, not a full Levenshtein — cheaper and enough here.
  static bool _editDistanceWithin1(String a, String b) {
    if (a == b) return true;
    final la = a.length, lb = b.length;
    if ((la - lb).abs() > 1) return false;
    var i = 0, j = 0, diffs = 0;
    while (i < la && j < lb) {
      if (a.codeUnitAt(i) == b.codeUnitAt(j)) {
        i++;
        j++;
        continue;
      }
      if (++diffs > 1) return false;
      if (la == lb) {
        i++;
        j++;
      } else if (la > lb) {
        i++;
      } else {
        j++;
      }
    }
    if (i < la || j < lb) diffs++;
    return diffs <= 1;
  }
}

enum _Perm { granted, notAsked, blocked }

class _Match {
  final MenuItem item;
  final double score;
  _Match(this.item, this.score);
}
