// NamastePOS dashboard — client-side GST ESTIMATE for the POS totals panel.
//
// 2026-09-05 (review P0): the web POS used to ship a manual "Tax (₹)" input
// that defaulted to 0, so every web order was persisted with ₹0 GST unless
// the cashier typed a number. The backend now treats an OMITTED `tax` field
// as "server computes GST from menu_items.gst_pct" and returns the persisted
// order with tax/cgst/sgst/igst/total. The dialog therefore no longer sends
// `tax` at all — but the cashier still has to COLLECT the right amount before
// the round-trip, so this mirrors the server's arithmetic for display and for
// the split-payment / wallet math.
//
// This is a faithful port of namastepos_backend/src/services/gstService2.js
// `computeGstBreakdown` (intra-state path):
//   • bucket line amounts (price × qty) by slab,
//   • per bucket: gst = round2(taxable × pct / 100),
//   • CGST = round2(gst / 2), SGST = gst − CGST (paise-exact split),
//   • totals rounded to 2 dp.
// The server applies GST to the RAW line amounts (before the cashier
// discount), so `discount` is deliberately not an input here. The server's
// figure is authoritative — anything downstream of create must read the
// returned order, never this estimate.
//
// Composition-scheme dealers (business.gstScheme === 'composition', see
// gstSchemeService.chargesNoGst) issue a bill of supply and charge the diner
// nothing; callers pass that scheme and get an all-zero result.

export type GstLine = { price: number; qty: number; gstPct?: number | null };

export type GstEstimate = {
  cgst: number;
  sgst: number;
  totalGst: number;
  /** slab (as string, e.g. "5") → GST amount in INR */
  breakdown: Record<string, number>;
};

const round2 = (n: number) => +n.toFixed(2);

/** Mirrors backend gstSchemeService.chargesNoGst — only the composition scheme bills without GST. */
export function schemeChargesNoGst(gstScheme: string | null | undefined): boolean {
  return gstScheme === 'composition';
}

export function estimateGst(lines: GstLine[], gstScheme?: string | null): GstEstimate {
  const empty: GstEstimate = { cgst: 0, sgst: 0, totalGst: 0, breakdown: {} };
  if (schemeChargesNoGst(gstScheme)) return empty;
  const buckets: Record<string, number> = {};
  for (const l of lines) {
    const pct = Number(l.gstPct) || 0;
    const taxable = (Number(l.price) || 0) * (Number(l.qty) || 0);
    // Same key normalisation as the server: `buckets[pct]` with a numeric
    // key stringifies "5", not "5.0", so identical slabs always merge.
    const key = String(pct);
    buckets[key] = (buckets[key] || 0) + taxable;
  }
  let cgst = 0;
  let sgst = 0;
  const breakdown: Record<string, number> = {};
  for (const [pctStr, taxable] of Object.entries(buckets)) {
    const pct = parseFloat(pctStr);
    const gstAmt = round2(taxable * pct / 100);
    breakdown[pctStr] = gstAmt;
    const half = round2(gstAmt / 2);
    cgst += half;
    sgst += gstAmt - half;
  }
  cgst = round2(cgst);
  sgst = round2(sgst);
  return { cgst, sgst, totalGst: round2(cgst + sgst), breakdown };
}
