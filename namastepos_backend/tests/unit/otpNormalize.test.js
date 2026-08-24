// Unit test for OTP phone-normalization. Purely functional — no DB.

const { _normalizePhone } = require('../../src/services/otpService');

describe('otpService._normalizePhone', () => {
  test('adds +91 to bare 10-digit Indian number', () => {
    expect(_normalizePhone('9876543210')).toBe('+919876543210');
  });

  test('preserves an already +91-prefixed number', () => {
    expect(_normalizePhone('+919876543210')).toBe('+919876543210');
  });

  test('adds + to 91-prefixed 12-digit number', () => {
    expect(_normalizePhone('919876543210')).toBe('+919876543210');
  });

  test('strips spaces and dashes and parentheses', () => {
    expect(_normalizePhone('+91 (987) 654-3210')).toBe('+919876543210');
  });

  test('accepts a valid non-Indian international number', () => {
    expect(_normalizePhone('+14155552671')).toBe('+14155552671');
  });

  test('rejects a garbage input', () => {
    expect(() => _normalizePhone('not-a-number')).toThrow(/valid phone/i);
  });

  test('rejects a 5-digit fragment', () => {
    expect(() => _normalizePhone('12345')).toThrow(/valid phone/i);
  });

  test('rejects empty input', () => {
    expect(() => _normalizePhone('')).toThrow(/phone required/i);
    expect(() => _normalizePhone(null)).toThrow(/phone required/i);
    expect(() => _normalizePhone(undefined)).toThrow(/phone required/i);
  });
});
