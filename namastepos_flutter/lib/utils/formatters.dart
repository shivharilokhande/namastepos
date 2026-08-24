// NamastePOS - Number, currency, date formatters

import 'package:intl/intl.dart';

final _money = NumberFormat.currency(locale: 'en_IN', symbol: '₹', decimalDigits: 0);
final _money2 = NumberFormat.currency(locale: 'en_IN', symbol: '₹', decimalDigits: 2);
final _short = DateFormat('dd MMM');
final _date = DateFormat('dd MMM yyyy');
final _dateTime = DateFormat('dd MMM yyyy, hh:mm a');
final _time = DateFormat('hh:mm a');

class AppFmt {
  AppFmt._();

  static String money(num n, {bool decimals = false}) =>
      decimals ? _money2.format(n) : _money.format(n);

  /// Format a paise amount as rupees (e.g. 12500 → ₹125).
  static String moneyPaise(num paise, {bool decimals = false}) =>
      money(paise / 100, decimals: decimals);

  /// Plain ₹ amount without locale digit grouping — for fixed-width
  /// thermal-receipt columns where grouping commas would shift alignment.
  static String moneyPlain(num rupees, {int decimals = 2}) =>
      '₹${rupees.toStringAsFixed(decimals)}';

  /// Shared INR NumberFormat (2 decimals) for screens that need a
  /// NumberFormat object. Prefer [money] for one-off strings.
  static NumberFormat get inr2 => _money2;

  // Fix (2026-08-23, founder): all displayed times are pinned to IST
  // (12-hour, AM/PM) regardless of the device/emulator timezone. The
  // backend stores UTC; the product is India-only (DPDP hosting, IST
  // reports), so IST is the single display timezone — an emulator set
  // to UTC was showing "08:00 AM" for a 1:32 PM order.
  static DateTime _ist(DateTime d) =>
      d.toUtc().add(const Duration(hours: 5, minutes: 30));

  /// True when [d] falls on today's IST calendar day. Use this for every
  /// "today's revenue/expenses" bucket — comparing raw parsed timestamps
  /// against DateTime.now() breaks around midnight (e.g. a Postgres DATE
  /// serialises as 18:30Z of the previous day).
  static bool isISTToday(DateTime d) {
    final a = _ist(d);
    final b = _ist(DateTime.now());
    return a.year == b.year && a.month == b.month && a.day == b.day;
  }

  static String dateShort(DateTime d) => _short.format(_ist(d));
  static String date(DateTime d) => _date.format(_ist(d));
  static String dateTime(DateTime d) => _dateTime.format(_ist(d));
  static String time(DateTime d) => _time.format(_ist(d));

  static String quantity(double q) {
    if (q.truncateToDouble() == q) return q.toInt().toString();
    return q.toStringAsFixed(2);
  }

  static String relative(DateTime d) {
    final diff = DateTime.now().difference(d);
    if (diff.inSeconds < 60) return 'just now';
    if (diff.inMinutes < 60) return '${diff.inMinutes}m ago';
    if (diff.inHours < 24) return '${diff.inHours}h ago';
    return _short.format(d);
  }
}
