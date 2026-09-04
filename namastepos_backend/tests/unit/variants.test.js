// Sprint 1 / FF-201 / FF-202 — variant + modifier price math contract test.
// We exercise the price-folding logic that the POS uses to land a final
// line price on the order.

function lineTotalWithModifiers({ variantPrice, qty, modifierLines = [] }) {
  const modDelta = modifierLines.reduce((s, m) => s + (m.priceDeltaInr * (m.qty || 1)), 0);
  return (variantPrice + modDelta) * qty;
}

describe('Variants + modifiers line pricing', () => {
  test('variant only', () => {
    expect(lineTotalWithModifiers({ variantPrice: 240, qty: 2 })).toBe(480);
  });

  test('variant + single positive modifier', () => {
    const t = lineTotalWithModifiers({
      variantPrice: 240,
      qty: 1,
      modifierLines: [{ name: 'Extra cheese', priceDeltaInr: 30, qty: 1 }],
    });
    expect(t).toBe(270);
  });

  test('variant + negative modifier (substitution discount)', () => {
    const t = lineTotalWithModifiers({
      variantPrice: 240,
      qty: 1,
      modifierLines: [{ name: 'No paneer (less)', priceDeltaInr: -40, qty: 1 }],
    });
    expect(t).toBe(200);
  });

  test('multi-select modifiers with quantities', () => {
    const t = lineTotalWithModifiers({
      variantPrice: 100,
      qty: 2,
      modifierLines: [
        { name: 'Extra cheese', priceDeltaInr: 30, qty: 2 },
        { name: 'No onion', priceDeltaInr: 0, qty: 1 },
      ],
    });
    // (100 + (30*2) + (0*1)) * 2 = (100 + 60) * 2 = 320
    expect(t).toBe(320);
  });
});
