// Item-level GST math (Sprint 2 / FF-901)
const { computeGstBreakdown } = require('../../src/services/gstService2');

describe('GST breakdown', () => {
  test('single 5% slab, intra-state → CGST 2.5% + SGST 2.5%', () => {
    const r = computeGstBreakdown({
      orderItems: [{ price: 100, qty: 1, gst_pct: 5 }],
      isInterState: false,
    });
    expect(r.cgst).toBe(2.5);
    expect(r.sgst).toBe(2.5);
    expect(r.igst).toBe(0);
    expect(r.totalGst).toBe(5);
  });

  test('mixed slabs', () => {
    const r = computeGstBreakdown({
      orderItems: [
        { price: 100, qty: 1, gst_pct: 5 },
        { price: 200, qty: 1, gst_pct: 18 },
      ],
      isInterState: false,
    });
    // 5%×100 = ₹5 ; 18%×200 = ₹36 ; total ₹41
    expect(r.totalGst).toBe(41);
    expect(r.breakdown['5']).toBe(5);
    expect(r.breakdown['18']).toBe(36);
  });

  test('inter-state uses IGST', () => {
    const r = computeGstBreakdown({
      orderItems: [{ price: 100, qty: 1, gst_pct: 18 }],
      isInterState: true,
    });
    expect(r.igst).toBe(18);
    expect(r.cgst).toBe(0);
    expect(r.sgst).toBe(0);
  });
});
