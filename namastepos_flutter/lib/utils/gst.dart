// NamastePOS — item-level GST, ported from the backend (2026-09-05, review #2).
//
// This is a FAITHFUL port of two backend modules and must stay one:
//
//   namastepos_backend/src/services/gstService2.js      computeGstBreakdown
//   namastepos_backend/src/services/gstSchemeService.js  the three GST schemes
//
// Why the app needs its own copy at all: the SERVER is the authority on tax
// (the create-order call omits `tax` so orderService computes it from the
// menu's own slabs), but the cashier has to see the bill BEFORE the order is
// placed, split legs have to be sized against the real total, and an
// offline-queued order needs a receipt while the server is unreachable. All
// three need the same numbers the server will produce — so the arithmetic
// here mirrors the backend line for line, including its rounding order:
//
//   • bucket taxable amounts by slab (price × qty, unrounded)
//   • per slab: gstAmt = round2(taxable × pct / 100)
//   • intra-state: half = round2(gstAmt / 2); cgst += half; sgst += gstAmt − half
//     (so an odd paisa lands on SGST, exactly as the server does it)
//   • inter-state: igst += gstAmt
//   • totals round2'd once at the end
//
// If the backend changes its math, change THIS file and the unit test
// (test/utils/gst_test.dart) in the same commit. Never "improve" the rounding
// here on its own — a phone receipt that disagrees with the server's order
// row by one paisa is worse than either figure.

/// `+(x).toFixed(2)` in the backend. Dart's toStringAsFixed rounds the same
/// exact binary value, so the two agree paisa-for-paisa on money-sized inputs.
double round2(double v) => double.parse(v.toStringAsFixed(2));

/// One taxable line: the unit price the bill actually charges, its quantity
/// and the slab (0 / 5 / 12 / 18 / 28) from `menu_items.gst_pct`.
class GstLine {
  final double price;
  final double qty;
  final double gstPct;
  const GstLine({required this.price, required this.qty, required this.gstPct});
}

class GstBreakdown {
  /// slab (as the server keys it, e.g. '5' / '18') → GST amount for that slab.
  final Map<String, double> breakdown;
  final double cgst;
  final double sgst;
  final double igst;
  final double totalGst;
  const GstBreakdown({
    required this.breakdown,
    required this.cgst,
    required this.sgst,
    required this.igst,
    required this.totalGst,
  });

  static const zero = GstBreakdown(
      breakdown: <String, double>{}, cgst: 0, sgst: 0, igst: 0, totalGst: 0);

  bool get isZero => totalGst == 0;
  bool get isInterState => igst > 0;
}

/// Port of `computeGstBreakdown({ orderItems, isInterState })`.
///
/// Intra-state (CGST + SGST) is the default — the place of supply for food
/// eaten or picked up at the restaurant is the restaurant's own state.
/// [isInterState] opts into IGST for the rare genuine inter-state supply.
GstBreakdown computeGstBreakdown(Iterable<GstLine> lines,
    {bool isInterState = false}) {
  final buckets = <double, double>{};
  for (final it in lines) {
    final pct = it.gstPct;
    final taxable = it.price * it.qty;
    buckets[pct] = (buckets[pct] ?? 0) + taxable;
  }
  double cgst = 0, sgst = 0, igst = 0;
  final breakdown = <String, double>{};
  // JS `Object.entries` visits integer-like keys in ascending numeric order;
  // walk the slabs the same way so the running sums accumulate identically.
  final slabs = buckets.keys.toList()..sort();
  for (final pct in slabs) {
    final gstAmt = round2(buckets[pct]! * pct / 100);
    breakdown[_slabKey(pct)] = gstAmt;
    if (isInterState) {
      igst += gstAmt;
    } else {
      final half = round2(gstAmt / 2);
      cgst += half;
      sgst += gstAmt - half;
    }
  }
  return GstBreakdown(
    breakdown: breakdown,
    cgst: round2(cgst),
    sgst: round2(sgst),
    igst: round2(igst),
    totalGst: round2(cgst + sgst + igst),
  );
}

/// '5' for 5.0, '12.5' for 12.5 — the same string a JS object key would be.
String _slabKey(double pct) =>
    pct == pct.truncateToDouble() ? pct.toInt().toString() : pct.toString();

// ── GST scheme (gstSchemeService.js) ─────────────────────────────────────

/// The only values `businesses.gst_scheme` may hold (backend migration 092).
const kGstSchemeRegular = 'regular';
const kGstSchemeComposition = 'composition';
const kGstSchemeSpecifiedPremises = 'specified_premises';

/// True when this scheme means "charge the diner no GST, issue a bill of
/// supply". Mirrors `chargesNoGst(scheme)`: orderService refuses to put GST on
/// a composition dealer's orders even under ORDER_TAX_ENFORCE, so the app
/// must show none either.
bool gstSchemeChargesNoGst(String? scheme) => scheme == kGstSchemeComposition;

/// The slab a menu item defaults to under [scheme] — `defaultGstPct(scheme)`.
/// Only reached for a row whose `gstPct` the server did not send (an old
/// sqflite cache row from before the column existed); the live menu payload
/// always carries the real slab, and the server prices the order from its own
/// menu regardless. Unknown/null → 5, exactly like the backend.
double defaultGstPctForScheme(String? scheme) {
  switch (scheme) {
    case kGstSchemeComposition:
      return 0;
    case kGstSchemeSpecifiedPremises:
      return 18;
    default:
      return 5;
  }
}
