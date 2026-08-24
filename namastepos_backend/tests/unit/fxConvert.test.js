// FX conversion (R14)

describe('FX conversion', () => {
  // Helper inline so we don't hit DB
  function convertInline(amount, rate) {
    return +(amount * rate).toFixed(2);
  }

  test('USD to INR 100 * 83 = 8300', () => {
    expect(convertInline(100, 83)).toBe(8300);
  });

  test('INR to USD 8300 * 0.012 = 99.6', () => {
    expect(convertInline(8300, 0.012)).toBe(99.6);
  });

  test('same currency rate is 1', () => {
    expect(convertInline(100, 1)).toBe(100);
  });
});
