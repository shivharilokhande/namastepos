// ESC/POS receipt rendering (Sprint 5 / FF-801)
const { renderReceiptText } = require('../../src/services/printerService');

describe('Receipt rendering', () => {
  const sampleOrder = {
    orderNo: 42,
    source: 'dineIn',
    tableNo: '3',
    customerPhone: '9876543210',
    subtotal: 600,
    serviceChargeInr: 30,
    cgst: 15,
    sgst: 15,
    igst: 0,
    tax: 30,
    discount: 0,
    roundOffInr: 0,
    total: 660,
    paymentMethod: 'cash',
    createdAt: new Date('2026-05-20T13:00:00').toISOString(),
    tokenNo: 47,
  };
  const sampleItems = [
    { name: 'Paneer Tikka', qty: 2, price: 270, variantLabel: 'Half', modifierLines: [{ name: 'Extra cheese' }] },
    { name: 'Butter Naan', qty: 1, price: 60 },
  ];

  test('80mm receipt has header + items + total', () => {
    const out = renderReceiptText({
      template: { headerLines: ['My Cafe', 'Goa'], gstin: 'GSTIN1', showToken: true, showTaxBreakdown: true, paperWidthMm: 80, footerText: 'Thanks!' },
      order: sampleOrder,
      items: sampleItems,
    });
    expect(out).toContain('My Cafe');
    expect(out).toContain('Paneer Tikka');
    expect(out).toContain('Half');
    expect(out).toContain('Extra cheese');
    expect(out).toContain('TOTAL');
    expect(out).toContain('TOKEN #47');
    expect(out).toContain('Thanks!');
    expect(out).toContain('CGST');
  });

  test('duplicate flag prints DUPLICATE banner', () => {
    const out = renderReceiptText({
      template: { headerLines: [], paperWidthMm: 80 },
      order: sampleOrder,
      items: sampleItems,
      isDuplicate: true,
    });
    expect(out).toMatch(/DUPLICATE/);
  });
});
