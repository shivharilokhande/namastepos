// NamastePOS — central build-time configuration.
//
// Hardcode-audit fix (2026-08-24): the web-app origin and support contact
// used to be hardcoded in individual screens/widgets (qr_codes_screen,
// addon_locked, subscription_banner, settings_screen). Centralised here so
// a domain rename or support-channel change is a one-line dart-define,
// not a codebase sweep.

class AppConfig {
  AppConfig._();

  /// Web dashboard origin, used for QR deep links, marketplace/billing
  /// upsell links, etc. Override per environment:
  ///   --dart-define=WEB_APP_URL=https://staging.yourdomain.in
  static const String webAppUrl = String.fromEnvironment(
    'WEB_APP_URL',
    defaultValue: 'https://app.namastepos.in',
  );

  /// Support WhatsApp number (digits with country code, e.g. 91XXXXXXXXXX).
  /// Empty ⇒ the in-app WhatsApp support entry is hidden. Set via:
  ///   --dart-define=SUPPORT_WHATSAPP=91XXXXXXXXXX
  static const String supportWhatsApp =
      String.fromEnvironment('SUPPORT_WHATSAPP', defaultValue: '');

  static bool get hasSupportWhatsApp => supportWhatsApp.isNotEmpty;
}
