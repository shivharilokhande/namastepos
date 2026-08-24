// Sprint 1 / FF-301, FF-302, FF-303 — bill-math unit tests.
//
// Pure math, no DB. The service code (orderService.create) implements
// these formulas inline; we extract them here to lock the semantics so
// future refactors don't shift cents on us.

function billMath({
  subtotal, serviceChargePct = 0, tax = 0, discount = 0,
  discountIsPreTax = true, roundOffMode = 'nearest_rupee',
}) {
  // serviceChargePct is in percent units (5 = 5%) to match orderService.
  const serviceCharge = Math.max(0, Math.round(subtotal * serviceChargePct) / 100);
  let taxableBase = subtotal + serviceCharge;
  let total;
  if (discountIsPreTax) {
    taxableBase = Math.max(0, taxableBase - discount);
    total = Math.max(0, taxableBase + tax);
  } else {
    total = Math.max(0, subtotal + serviceCharge + tax - discount);
  }
  let roundOff = 0;
  if (roundOffMode !== 'none') {
    const rounded = roundOffMode === 'down' ? Math.floor(total) : Math.round(total);
    roundOff = +(rounded - total).toFixed(2);
    total = rounded;
  }
  return { serviceCharge: +serviceCharge.toFixed(2), total, roundOff };
}

describe('Bill math', () => {
  test('subtotal only, no charges', () => {
    expect(billMath({ subtotal: 100 })).toEqual({ serviceCharge: 0, total: 100, roundOff: 0 });
  });

  test('5% service charge', () => {
    expect(billMath({ subtotal: 100, serviceChargePct: 5 }))
      .toEqual({ serviceCharge: 5, total: 105, roundOff: 0 });
  });

  test('5% service + ₹10 discount pre-tax + ₹5 tax', () => {
    // subtotal 100 + service 5 = 105; discount 10 pre-tax → taxable 95; +tax 5 = 100
    const r = billMath({
      subtotal: 100, serviceChargePct: 5, discount: 10,
      tax: 5, discountIsPreTax: true,
    });
    expect(r.total).toBe(100);
    expect(r.serviceCharge).toBe(5);
    expect(r.roundOff).toBe(0);
  });

  test('5% service + ₹10 discount POST-tax + ₹5 tax', () => {
    // subtotal 100 + service 5 + tax 5 = 110; discount 10 post-tax → 100
    const r = billMath({
      subtotal: 100, serviceChargePct: 5, discount: 10,
      tax: 5, discountIsPreTax: false,
    });
    expect(r.total).toBe(100);
  });

  test('round-off nearest_rupee — up', () => {
    // total 99.7 → 100, round_off = +0.30
    const r = billMath({ subtotal: 99.70 });
    expect(r.total).toBe(100);
    expect(r.roundOff).toBe(0.3);
  });

  test('round-off nearest_rupee — down', () => {
    // total 100.4 → 100, round_off = -0.40
    const r = billMath({ subtotal: 100.4 });
    expect(r.total).toBe(100);
    expect(r.roundOff).toBe(-0.4);
  });

  test('round-off down mode floors', () => {
    const r = billMath({ subtotal: 100.7, roundOffMode: 'down' });
    expect(r.total).toBe(100);
  });

  test('round-off none preserves paise', () => {
    const r = billMath({ subtotal: 100.7, roundOffMode: 'none' });
    expect(r.total).toBe(100.7);
    expect(r.roundOff).toBe(0);
  });

  test('discount cannot drive total negative', () => {
    const r = billMath({ subtotal: 100, discount: 500 });
    expect(r.total).toBeGreaterThanOrEqual(0);
  });
});
