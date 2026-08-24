// NamastePOS - Validators

class Validators {
  Validators._();

  static String? phone(String? v) {
    if (v == null || v.trim().isEmpty) return 'Phone is required';
    final digits = v.replaceAll(RegExp(r'[^0-9]'), '');
    if (digits.length < 10) return 'Enter a 10-digit phone';
    return null;
  }

  static String? required(String? v, {String label = 'This field'}) {
    if (v == null || v.trim().isEmpty) return '$label is required';
    return null;
  }

  static String? positiveNumber(String? v, {String label = 'Value'}) {
    if (v == null || v.trim().isEmpty) return '$label is required';
    final d = double.tryParse(v.trim());
    if (d == null) return 'Enter a number';
    if (d <= 0) return '$label must be > 0';
    return null;
  }

  static String? nonNegativeNumber(String? v) {
    if (v == null || v.trim().isEmpty) return null;
    final d = double.tryParse(v.trim());
    if (d == null) return 'Enter a number';
    if (d < 0) return 'Must be >= 0';
    return null;
  }
}
