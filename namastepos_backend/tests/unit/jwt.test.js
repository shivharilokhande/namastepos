// Verifies the QA-1 impersonation TTL behaviour.

process.env.JWT_SECRET = 'test-secret-please-change';
process.env.JWT_EXPIRES_IN = '1h';

const { issueAccessToken, verifyAccessToken } = require('../../src/utils/jwt');

describe('JWT issue / verify', () => {
  test('normal token uses configured TTL', () => {
    const t = issueAccessToken({ sub: 'u1', email: 'a@b.com' });
    const payload = verifyAccessToken(t);
    expect(payload.sub).toBe('u1');
    expect(payload.exp - payload.iat).toBeGreaterThanOrEqual(3500);
  });

  test('impersonation token gets 15-minute TTL regardless of config', () => {
    const t = issueAccessToken({ sub: 'admin', email: 'a@b.com', imp: true });
    const payload = verifyAccessToken(t);
    expect(payload.imp).toBe(true);
    const ttl = payload.exp - payload.iat;
    expect(ttl).toBeLessThanOrEqual(15 * 60 + 5);
    expect(ttl).toBeGreaterThanOrEqual(15 * 60 - 5);
  });

  test('explicit expiresIn overrides defaults', () => {
    const t = issueAccessToken({ sub: 'x' }, { expiresIn: '5m' });
    const payload = verifyAccessToken(t);
    const ttl = payload.exp - payload.iat;
    expect(ttl).toBeLessThanOrEqual(5 * 60 + 5);
  });
});
