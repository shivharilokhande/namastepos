// Item-level GST calculation (Sprint 2 / FF-901)
//
// India splits GST into CGST + SGST (intra-state) or IGST (inter-state).
// We compute per-slab buckets from order_items.gst_pct, then split into
// CGST/SGST or IGST based on business.state_code vs delivery state.

function computeGstBreakdown({ orderItems, isInterState = false }) {
  // bucket[pct] = taxable_amount
  const buckets = {};
  for (const it of orderItems) {
    const pct = it.gst_pct || 0;
    const taxable = (it.price || 0) * (it.qty || 0);
    buckets[pct] = (buckets[pct] || 0) + taxable;
  }
  let cgst = 0, sgst = 0, igst = 0;
  const breakdown = {};
  for (const [pctStr, taxable] of Object.entries(buckets)) {
    const pct = parseFloat(pctStr);
    const gstAmt = +(taxable * pct / 100).toFixed(2);
    breakdown[pctStr] = gstAmt;
    if (isInterState) {
      igst += gstAmt;
    } else {
      const half = +(gstAmt / 2).toFixed(2);
      cgst += half;
      sgst += gstAmt - half;
    }
  }
  return {
    breakdown,
    cgst: +cgst.toFixed(2),
    sgst: +sgst.toFixed(2),
    igst: +igst.toFixed(2),
    totalGst: +(cgst + sgst + igst).toFixed(2),
  };
}

module.exports = { computeGstBreakdown };
