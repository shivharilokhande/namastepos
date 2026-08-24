// Bill split math (FF-304)

describe('Bill split math', () => {
  function equalSplit(totalPaise, n) {
    const per = Math.floor(totalPaise / n);
    const remainder = totalPaise - (per * n);
    return Array.from({ length: n }, (_, i) => per + (i === 0 ? remainder : 0));
  }

  test('split ₹100 into 3 — first gets the extra paisa', () => {
    const splits = equalSplit(10000, 3); // ₹100.00 in paise
    expect(splits.reduce((s, x) => s + x, 0)).toBe(10000);
    expect(splits[0]).toBeGreaterThanOrEqual(splits[1]);
  });

  test('exact division has no remainder', () => {
    const splits = equalSplit(9000, 3);
    expect(splits).toEqual([3000, 3000, 3000]);
  });

  test('custom amounts must sum to total', () => {
    const total = 10000;
    const amounts = [3000, 4000, 3000];
    expect(amounts.reduce((s, x) => s + x, 0)).toBe(total);
  });
});
