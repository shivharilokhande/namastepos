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
        'createdAt': createdAt.toIso8601String(),
      };
}
