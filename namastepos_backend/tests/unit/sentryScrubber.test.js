// Unit tests for the Sentry PII scrubber (FF-215).
//
// The scrubber is pure/synchronous so we can drive it directly with
// synthetic payloads — no Sentry SDK or network calls needed.

const sentry = require('../../src/config/sentry');
const { __scrubString: scrubString, __scrubTree: scrubTree, __beforeSend: beforeSend } = sentry;

describe('PII scrubber — strings', () => {
  test('scrubs email addresses', () => {
    expect(scrubString('contact shivlokhande7080@gmail.com now'))
      .toBe('contact <redacted:email> now');
  });
  test('scrubs Indian mobile numbers with & without +91', () => {
    expect(scrubString('customer 9518956711 called')).toBe('customer <redacted:phone> called');
    expect(scrubString('customer +919518956711 called')).toBe('customer <redacted:phone> called');
    expect(scrubString('customer +91 9518956711 called')).toBe('customer <redacted:phone> called');
  });
  test('does NOT scrub US 10-digit numbers starting <6', () => {
    // The Indian mobile regex requires the first digit to be 6-9. A random
    // 10-digit US number starting with 4 shouldn't false-match.
    expect(scrubString('order id 4155551234')).toBe('order id 4155551234');
  });
  test('scrubs JWT tokens', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(scrubString(`Auth failed with ${jwt}`))
      .toBe('Auth failed with <redacted:token>');
  });
  test('scrubs Bearer headers', () => {
    expect(scrubString('Authorization: Bearer abc123.def456.ghi789'))
      .toBe('Authorization: Bearer <redacted:token>');
  });
  test('is a no-op for non-strings', () => {
    expect(scrubString(42)).toBe(42);
    expect(scrubString(null)).toBe(null);
    expect(scrubString(undefined)).toBe(undefined);
  });
});

describe('PII scrubber — trees', () => {
  test('redacts sensitive keys wholesale', () => {
    const input = {
      customerPhone: '9518956711',
      customerName: 'Rohit',
      password: 'hunter2',
      refreshToken: 'eyJabc...',
      businessId: 'biz-1',
      itemName: 'Paneer Tikka',
    };
    const out = scrubTree(input);
    expect(out.customerPhone).toBe('<redacted>');
    expect(out.customerName).toBe('<redacted>');
    expect(out.password).toBe('<redacted>');
    expect(out.refreshToken).toBe('<redacted>');
    // Non-sensitive fields survive
    expect(out.businessId).toBe('biz-1');
    expect(out.itemName).toBe('Paneer Tikka');
  });
  test('scrubs strings recursively inside arrays and nested objects', () => {
    const input = {
      logs: [
        'user shivlokhande7080@gmail.com logged in',
        { note: 'called 9518956711 twice' },
      ],
    };
    const out = scrubTree(input);
    expect(out.logs[0]).toBe('user <redacted:email> logged in');
    expect(out.logs[1].note).toBe('called <redacted:phone> twice');
  });
  test('does not blow up on cycles (depth-limited)', () => {
    const a = {};
    a.self = a;                 // cyclic
    expect(() => scrubTree(a)).not.toThrow();
  });
});

describe('beforeSend hook', () => {
  test('strips user email/name and headers', () => {
    const event = {
      user: { id: 'u-1', email: 'x@y.com', ip_address: '1.2.3.4' },
      request: {
        headers: { authorization: 'Bearer x', cookie: 'ff_refresh=abc', accept: 'application/json' },
        cookies: { ff_refresh: 'abc' },
        data: { password: 'x', ok: true },
        query_string: 'phone=9518956711',
      },
      message: 'Login failed for shivlokhande7080@gmail.com',
      exception: {
        values: [{ type: 'Error', value: 'Bad token eyJabc.def.ghi' }],
      },
      breadcrumbs: [{ message: 'called 9518956711', data: { phone: '9518956711' } }],
    };
    const out = beforeSend(event);
    expect(out.user).toEqual({ id: 'u-1' });
    expect(out.request.headers.authorization).toBe('<redacted>');
    expect(out.request.headers.cookie).toBe('<redacted>');
    expect(out.request.headers.accept).toBe('application/json');
    expect(out.request.cookies).toBe('<redacted>');
    expect(out.request.data.password).toBe('<redacted>');
    expect(out.request.data.ok).toBe(true);
    expect(out.request.query_string).toBe('phone=<redacted:phone>');
    expect(out.message).toContain('<redacted:email>');
    expect(out.exception.values[0].value).toContain('<redacted:token>');
    expect(out.breadcrumbs[0].message).toContain('<redacted:phone>');
    expect(out.breadcrumbs[0].data.phone).toBe('<redacted>');
  });
  test('returns null (drop event) on internal error', () => {
    // Feed a getter that throws to force the outer try/catch.
    const evil = new Proxy({}, { get() { throw new Error('boom'); } });
    // beforeSend should catch and return null rather than blow up
    expect(beforeSend(evil)).toBe(null);
  });
});
