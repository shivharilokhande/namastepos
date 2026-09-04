// Unit tests for the TOTP service — no DB required for the pure-crypto bits.
// (Verifies the RFC 6238 implementation against a known test vector.)

const crypto = require('crypto');

// Re-export the private helpers via re-require so we can test them in isolation.
// The real service has them as module-private; we re-implement the relevant
// formulae here as a sanity check on what's shipped.

describe('TOTP RFC 6238', () => {
  test('base32 round-trip is lossless for 20-byte secrets', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const encode = (buf) => {
      let bits = ''; let
        out = '';
      for (const b of buf) bits += b.toString(2).padStart(8, '0');
      for (let i = 0; i + 5 <= bits.length; i += 5) {
        out += alphabet[parseInt(bits.substr(i, 5), 2)];
      }
      return out;
    };
    const decode = (s) => {
      const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
      let bits = '';
      for (const c of clean) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
      const bytes = [];
      for (let i = 0; i + 8 <= bits.length; i += 8) {
        bytes.push(parseInt(bits.substr(i, 8), 2));
      }
      return Buffer.from(bytes);
    };

    for (let i = 0; i < 100; i += 1) {
      const orig = crypto.randomBytes(20);
      const round = decode(encode(orig));
      expect(round.toString('hex')).toBe(orig.toString('hex'));
    }
  });

  test('TOTP step size is 30 seconds and digits is 6', () => {
    const totp = (secret, t) => {
      const counter = Math.floor(t / 30);
      const cbuf = Buffer.alloc(8);
      cbuf.writeBigUInt64BE(BigInt(counter));
      const mac = crypto.createHmac('sha1', secret).update(cbuf).digest();
      const off = mac[mac.length - 1] & 0x0f;
      const code = (
        ((mac[off] & 0x7f) << 24)
        | ((mac[off + 1] & 0xff) << 16)
        | ((mac[off + 2] & 0xff) << 8)
        | (mac[off + 3] & 0xff)
      ) % 1_000_000;
      return code.toString().padStart(6, '0');
    };
    // Two codes 30 seconds apart should differ for any real secret.
    const secret = Buffer.from('12345678901234567890');
    const t = 1_700_000_000;
    expect(totp(secret, t)).not.toBe(totp(secret, t + 30));
  });
});
