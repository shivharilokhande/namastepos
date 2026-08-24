// NamastePOS - Cart item (in-memory only) used during order entry.
//
// Each row in the running cart. A single menu item can produce MULTIPLE
// CartItem rows when ordered with different variants or modifier combos
// (e.g. one "Pizza Small + extra cheese" and another "Pizza Large no cheese"
// are two separate lines, not one line with qty 2).

import 'menu_item.dart';

class ModifierLine {
  final String? groupId;
  final String groupLabel;
  final String? optionId;
  final String optionLabel;
  final double priceDelta;          // INR

  ModifierLine({
    this.groupId,
    required this.groupLabel,
    this.optionId,
    required this.optionLabel,
    this.priceDelta = 0,
  });

  Map<String, dynamic> toJson() => {
        'groupId': groupId,
        'groupLabel': groupLabel,
        'optionId': optionId,
        'optionLabel': optionLabel,
        'priceDelta': priceDelta,
      };
}

class CartItem {
  final MenuItem item;
  int qty;
  String? note;
  // Variant — Small / Medium / Large kind of choice
  String? variantId;
  String? variantLabel;
  double? variantPrice;             // unit price override if a variant is picked
  // Modifier add-ons — checkboxes / radios from modifier groups
  List<ModifierLine> modifiers;

  CartItem({
    required this.item,
    this.qty = 1,
    this.note,
    this.variantId,
    this.variantLabel,
    this.variantPrice,
    List<ModifierLine>? modifiers,
  }) : modifiers = modifiers ?? [];

  /// Effective unit price = variant override (if set) else item base price,
  /// plus the sum of modifier `priceDelta`.
  double get unitPrice {
    final base = variantPrice ?? item.price;
    final addOns = modifiers.fold<double>(0, (s, m) => s + m.priceDelta);
    return base + addOns;
  }

  double get lineTotal => unitPrice * qty;

  /// Composite key used to dedupe same-config lines. If two CartItems have
  /// the same key, they collapse into one with summed qty.
  String get lineKey {
    final modKey = (modifiers.map((m) => '${m.optionId ?? m.optionLabel}').toList()..sort()).join('|');
    return '${item.id}|${variantId ?? ''}|$modKey|${note ?? ''}';
  }

  /// Compact summary line shown under the item name in the cart panel.
  String get configSummary {
    final parts = <String>[];
    if (variantLabel != null && variantLabel!.isNotEmpty) parts.add(variantLabel!);
    parts.addAll(modifiers.map((m) => m.optionLabel));
    return parts.join(' · ');
  }
}
