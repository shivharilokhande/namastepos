// Aggregator webhook HMAC verification (Sprint 2 / FF-101)
const crypto = require('crypto');
const { verifySignature } = require('../../src/services/aggregatorService');

function sign(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

describe('Aggregator webhook signatures', () => {
  test('valid signature → true', () => {
    const body = '{"order":{"id":"abc"}}';
    const sig = sign('shh', body);
    expect(verifySignature('zomato', 'shh', body, sig)).toBe(true);
  });
  test('mutated body → false', () => {
    const sig = sign('shh', '{"a":1}');
    expect(verifySignature('zomato', 'shh', '{"a":2}', sig)).toBe(false);
  });
  test('wrong secret → false', () => {
    const sig = sign('wrong', '{}');
    expect(verifySignature('zomato', 'right', '{}', sig)).toBe(false);
  });
  test('malformed sig → false (no crash)', () => {
    expect(verifySignature('zomato', 'shh', '{}', 'not-hex')).toBe(false);
    expect(verifySignature('zomato', 'shh', '{}', '')).toBe(false);
    expect(verifySignature('zomato', 'shh', '{}', null)).toBe(false);
  });
});
