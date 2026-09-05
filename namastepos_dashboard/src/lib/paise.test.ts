// Money boundary for the round-2 endpoints: rupees typed → paise on the wire.
import { describe, it, expect } from 'vitest';
import { inrToPaise, lineTotalPaise, paiseToInr } from './paise';

describe('recurring invoices — rupee → paise', () => {
  it('converts typed rupees to integer paise', () => {
    expect(inrToPaise('100')).toBe(10000);
    expect(inrToPaise('12.5')).toBe(1250);
    expect(inrToPaise('0.1')).toBe(10);
    expect(inrToPaise(19.99)).toBe(1999);
  });
  it('never emits a float, NaN or negative', () => {
    expect(inrToPaise('abc')).toBe(0);
    expect(inrToPaise('-5')).toBe(0);
    expect(inrToPaise('')).toBe(0);
    expect(Number.isInteger(inrToPaise('33.335'))).toBe(true);
  });
  it('round-trips paise → rupees for display', () => {
    expect(paiseToInr(21000)).toBe(210);
    expect(paiseToInr(1)).toBe(0.01);
    expect(paiseToInr(null)).toBe(0);
    expect(paiseToInr(inrToPaise('12.5'))).toBe(12.5);
  });
  it('line total includes GST on the paise base', () => {
    // 2 × ₹100 @ 5% → ₹210.00
    expect(lineTotalPaise(2, 10000, 5)).toBe(21000);
    // 3 × ₹33.33 @ 18% → base 9999 + 1800 (1799.82 rounded) = 11799
    expect(lineTotalPaise(3, 3333, 18)).toBe(11799);
    expect(lineTotalPaise(1, 5000, 0)).toBe(5000);
  });
});
