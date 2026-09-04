// Unit test for token receipt formatter

const { formatToken } = require('../../src/utils/tokenPrinter');

describe('formatToken', () => {
  const business = {
    name: 'Sharma Tea Stall',
    address: 'Andheri West, Mumbai',
    phone: '+919876543210',
    upi_id: 'sharma@upi',
  };
  const order = {
    orderNo: 42,
    source: 'dineIn',
    tableNo: '3',
    customerPhone: '+919999999999',
    createdAt: '2026-05-17T08:00:00.000Z',
    paymentMethod: 'cash',
    items: [
      { name: 'Masala Dosa', price: 80, qty: 2, note: 'extra spice' },
      { name: 'Chai', price: 15, qty: 3 },
    ],
    subtotal: 205,
    tax: 0,
    discount: 10,
    total: 195,
  };

  it('produces a 32-column receipt', () => {
    const out = formatToken(order, business);
    expect(out).toMatch(/SHARMA TEA STALL/);
    expect(out).toMatch(/TOKEN #42/);
    expect(out).toMatch(/Masala Dosa/);
    expect(out).toMatch(/\(extra spice\)/);
    expect(out).toMatch(/Subtotal/);
    expect(out).toMatch(/TOTAL/);
    expect(out).toMatch(/PAID by CASH/);
    expect(out).toMatch(/Powered by NamastePOS/);
  });
});
