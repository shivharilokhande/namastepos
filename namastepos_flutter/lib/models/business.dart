// NamastePOS - Business (account/tenant) model

class Business {
  final String id;
  final String name;
  final String phone;
  final String? city;
  final String? category;          // e.g. tea-stall, cloud-kitchen, dhaba
  final String? gstin;
  final String? logoUrl;
  final String? bankAccount;
  final String? bankIfsc;
  final String? upiId;
  final String? address;
  // FF-217b: whether the first-run wizard has been completed.
  // Defaults to `true` when the field is missing on the payload so
  // legacy accounts don't get forced through the wizard.
  final bool onboarded;
  // FF-252 / Bug fix B13: business-wide service-mode default. Values:
  // 'dine_in' (waiter serves), 'self_pickup' (guest collects), or
  // 'hybrid' (per-table decides). Wizard writes this on step 0.
  final String defaultServiceMode;
  // 2026-09-05 (backend migration 092) — the GST scheme the owner declared in
  // the setup wizard. One of 'regular' (5%, no ITC — the common case),
  // 'composition' (no GST on the bill; they issue a bill of supply) or
  // 'specified_premises' (18% with ITC). Defaults to 'regular' for every
  // account that has not answered, which is the behaviour they already had.
  //
  // It is NOT a display preference: the backend uses it to pick the default
  // gst_pct on new menu items and to refuse to put GST on a composition
  // dealer's bill at all. The app reads it so the printed bill can say
  // "Bill of supply" rather than showing a tax invoice with no tax on it.
  final String gstScheme;
  final DateTime createdAt;

  Business({
    required this.id,
    required this.name,
    required this.phone,
    this.city,
    this.category,
    this.gstin,
    this.logoUrl,
    this.bankAccount,
    this.bankIfsc,
    this.upiId,
    this.address,
    this.onboarded = true,
    this.defaultServiceMode = 'hybrid',
    this.gstScheme = 'regular',
    required this.createdAt,
  });

  Business copyWith({
    String? name,
    String? city,
    String? category,
    String? gstin,
    String? logoUrl,
    String? bankAccount,
    String? bankIfsc,
    String? upiId,
    String? address,
    String? gstScheme,
  }) {
    return Business(
      id: id,
      name: name ?? this.name,
      phone: phone,
      city: city ?? this.city,
      category: category ?? this.category,
      gstin: gstin ?? this.gstin,
      logoUrl: logoUrl ?? this.logoUrl,
      bankAccount: bankAccount ?? this.bankAccount,
      bankIfsc: bankIfsc ?? this.bankIfsc,
      upiId: upiId ?? this.upiId,
      address: address ?? this.address,
      onboarded: onboarded,
      defaultServiceMode: defaultServiceMode,
      gstScheme: gstScheme ?? this.gstScheme,
      createdAt: createdAt,
    );
  }

  factory Business.fromMap(Map<String, dynamic> m) => Business(
        id: m['id'] as String,
        name: m['name'] as String? ?? '',
        phone: m['phone'] as String? ?? '',
        city: m['city'] as String?,
        category: m['category'] as String?,
        gstin: m['gstin'] as String?,
        logoUrl: m['logoUrl'] as String?,
        bankAccount: m['bankAccount'] as String?,
        bankIfsc: m['bankIfsc'] as String?,
        upiId: m['upiId'] as String?,
        address: m['address'] as String?,
        onboarded: m['onboarded'] as bool? ?? true,
        defaultServiceMode:
            m['defaultServiceMode'] as String? ?? 'hybrid',
        gstScheme: m['gstScheme'] as String? ?? 'regular',
        createdAt: DateTime.tryParse(m['createdAt']?.toString() ?? '') ??
            DateTime.now(),
      );

  Map<String, dynamic> toMap() => {
        'id': id,
        'name': name,
        'phone': phone,
        'city': city,
        'category': category,
        'gstin': gstin,
        'logoUrl': logoUrl,
        'bankAccount': bankAccount,
        'bankIfsc': bankIfsc,
        'upiId': upiId,
        'address': address,
        'onboarded': onboarded,
        'defaultServiceMode': defaultServiceMode,
        'gstScheme': gstScheme,
        'createdAt': createdAt.toIso8601String(),
      };
}
