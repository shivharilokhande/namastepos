import { describe, it, expect } from 'vitest';
import { estimateGst, schemeChargesNoGst } from './gstEstimate';

describe('estimateGst — mirrors gstService2.computeGstBreakdown (intra-state)', () => {
  it('2 × ₹100 @ 5% → total 10.00, CGST 5.00, SGST 5.00', () => {
    const r = estimateGst([{ price: 100, qty: 2, gstPct: 5 }]);
    expect(r.totalGst).toBe(10);
    expect(r.cgst).toBe(5);
    expect(r.sgst).toBe(5);
    expect(r.breakdown).toEqual({ '5': 10 });
  });

  it('merges identical slabs and keeps the paise-exact CGST/SGST split', () => {
    // 3 × ₹33.33 @ 5% = 99.99 → GST 5.00 (round2 of 4.9995) → 2.50 / 2.50
    // plus ₹10 @ 18% → 1.80 → 0.90 / 0.90
    const r = estimateGst([
      { price: 33.33, qty: 3, gstPct: 5 },
      { price: 10, qty: 1, gstPct: 18 },
    ]);
    expect(r.breakdown['5']).toBe(5);
    expect(r.breakdown['18']).toBe(1.8);
    expect(r.cgst).toBe(3.4);
    expect(r.sgst).toBe(3.4);
    expect(r.totalGst).toBe(6.8);
  });

  it('an odd-paise slab amount puts the extra paisa on SGST, never loses it', () => {
    // ₹1.01 @ 5% = 0.0505 → 0.05 → CGST round2(0.025)=0.03 (JS toFixed) / SGST 0.02
    const r = estimateGst([{ price: 1.01, qty: 1, gstPct: 5 }]);
    expect(+(r.cgst + r.sgst).toFixed(2)).toBe(0.05);
    expect(r.totalGst).toBe(0.05);
  });

  it('missing gstPct is treated as 0% (bill of supply lines)', () => {
    const r = estimateGst([{ price: 50, qty: 2 }]);
    expect(r.totalGst).toBe(0);
    expect(r.breakdown).toEqual({ '0': 0 });
  });

  it('composition scheme charges no GST at all', () => {
    expect(schemeChargesNoGst('composition')).toBe(true);
    expect(schemeChargesNoGst('regular')).toBe(false);
    expect(schemeChargesNoGst(null)).toBe(false);
    const r = estimateGst([{ price: 100, qty: 2, gstPct: 5 }], 'composition');
    expect(r).toEqual({ cgst: 0, sgst: 0, totalGst: 0, breakdown: {} });
  });
});
