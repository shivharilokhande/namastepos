// Integration tests for /v1/wa-webhooks/:businessId
//
// Regression suite for AUDIT-S004/S005 (P0 fix in routes/whatsappWebhook.routes.js):
//  - S004: webhook accepted ANY POST body without verifying Twilio's signature
//  - S005: :businessId was used verbatim in DB writes; must reject non-UUID

const request = require('supertest');
const crypto = require('crypto');
const buildApp = require('../../src/app');
const env = require('../../src/config/env');
const { resetDb, makeBusiness, closePool } = require('../setup');

// Mock whatsappService so we can assert handleInbound was/wasn't called.
jest.mock('../../src/services/whatsappService', () => ({
  handleInbound: jest.fn(async () => ({ ok: true })),
}));

const whatsapp = require('../../src/services/whatsappService');

let app;
let owner;
const TWILIO_TOKEN = 'test-twilio-auth-token';

beforeAll(async () => {
  process.env.TWILIO_AUTH_TOKEN = TWILIO_TOKEN;
  // Also set env.TWILIO_AUTH_TOKEN since env values are frozen at module load.
  env.TWILIO_AUTH_TOKEN = TWILIO_TOKEN;
  await resetDb();
  app = buildApp();
  owner = await makeBusiness({ email: 'wa@example.com', name: 'WA Test' });
});

afterAll(async () => {
  delete process.env.TWILIO_AUTH_TOKEN;
  env.TWILIO_AUTH_TOKEN = '';
  await closePool();
});

beforeEach(() => {
  whatsapp.handleInbound.mockClear();
});

function twilioSign(url, params, token = TWILIO_TOKEN) {
  const sorted = Object.keys(params).sort();
  const data = sorted.reduce((acc, k) => acc + k + params[k], url);
  return crypto.createHmac('sha1', token).update(data).digest('base64');
}

// env.NODE_ENV is captured at module load, so flipping process.env.NODE_ENV
// at test time doesn't affect env.isProd(). Spy on it directly.
function withProd(testFn) {
  return async () => {
    const spy = jest.spyOn(env, 'isProd').mockReturnValue(true);
    try {
      await testFn();
    } finally {
      spy.mockRestore();
    }
  };
}

describe('POST /v1/wa-webhooks/:businessId — SIGNATURE (AUDIT-S004)', () => {
  it('accepts a request with a valid X-Twilio-Signature', async () => {
    const url = `http://127.0.0.1/v1/wa-webhooks/${owner.id}`;
    const params = { From: 'whatsapp:+919876543210', Body: 'Hello', MessageSid: 'SM1' };
    const sig = twilioSign(url, params);
    const res = await request(app)
      .post(`/v1/wa-webhooks/${owner.id}`)
      .set('host', '127.0.0.1')
      .set('x-twilio-signature', sig)
      .type('form')
      .send(params);
    expect(res.status).toBe(200);
    expect(whatsapp.handleInbound).toHaveBeenCalledTimes(1);
    expect(whatsapp.handleInbound).toHaveBeenCalledWith(
      owner.id,
      expect.objectContaining({ phone: '+919876543210', body: 'Hello', providerMsgId: 'SM1' }),
    );
  });

  it('accepts the request in dev when no token is configured (with warning)', async () => {
    const saved = process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_AUTH_TOKEN;
    const res = await request(app)
      .post(`/v1/wa-webhooks/${owner.id}`)
      .type('form')
      .send({ From: 'whatsapp:+919999999999', Body: 'test' });
    expect(res.status).toBe(200);
    process.env.TWILIO_AUTH_TOKEN = saved;
  });

  it('REJECTS a missing signature when token is configured + isProd()=true', withProd(async () => {
    const res = await request(app)
      .post(`/v1/wa-webhooks/${owner.id}`)
      .type('form')
      .send({ From: 'whatsapp:+919999999999', Body: 'test' });
    expect(res.status).toBe(401);
    expect(whatsapp.handleInbound).not.toHaveBeenCalled();
  }));

  it('REJECTS a bad signature in production', withProd(async () => {
    const res = await request(app)
      .post(`/v1/wa-webhooks/${owner.id}`)
      .set('x-twilio-signature', 'totally-wrong')
      .type('form')
      .send({ From: 'whatsapp:+919999999999', Body: 'test' });
    expect(res.status).toBe(401);
    expect(whatsapp.handleInbound).not.toHaveBeenCalled();
  }));

  it('REJECTS a signature computed with the wrong token in production', withProd(async () => {
    const url = `http://127.0.0.1/v1/wa-webhooks/${owner.id}`;
    const params = { From: 'whatsapp:+919999999999', Body: 'test' };
    const wrongSig = twilioSign(url, params, 'wrong-token');
    const res = await request(app)
      .post(`/v1/wa-webhooks/${owner.id}`)
      .set('host', '127.0.0.1')
      .set('x-twilio-signature', wrongSig)
      .type('form')
      .send(params);
    expect(res.status).toBe(401);
  }));
});

describe('POST /v1/wa-webhooks/:businessId — UUID VALIDATION (AUDIT-S005)', () => {
  it('rejects non-UUID :businessId with 400', async () => {
    const res = await request(app)
      .post('/v1/wa-webhooks/not-a-uuid')
      .type('form')
      .send({ From: 'whatsapp:+919999999999', Body: 'test' });
    expect(res.status).toBe(400);
    expect(whatsapp.handleInbound).not.toHaveBeenCalled();
  });

  it('rejects path traversal in :businessId', async () => {
    const res = await request(app)
      .post('/v1/wa-webhooks/..%2F..%2Fadmin')
      .type('form')
      .send({ From: 'whatsapp:+919999999999', Body: 'test' });
    expect([400, 404]).toContain(res.status);
    expect(whatsapp.handleInbound).not.toHaveBeenCalled();
  });
});

describe('POST /v1/wa-webhooks/:businessId — SHAPE', () => {
  it('strips "whatsapp:" prefix from the phone before handing off', async () => {
    const url = `http://127.0.0.1/v1/wa-webhooks/${owner.id}`;
    const params = { From: 'whatsapp:+919876543210', Body: 'Order', MessageSid: 'SM9' };
    const sig = twilioSign(url, params);
    await request(app)
      .post(`/v1/wa-webhooks/${owner.id}`)
      .set('host', '127.0.0.1')
      .set('x-twilio-signature', sig)
      .type('form')
      .send(params);
    expect(whatsapp.handleInbound.mock.calls[0][1].phone).toBe('+919876543210');
  });

  it('always returns TwiML <Response/> XML (Twilio expects this)', async () => {
    const url = `http://127.0.0.1/v1/wa-webhooks/${owner.id}`;
    const params = { From: 'whatsapp:+918888888888', Body: 'Hello' };
    const sig = twilioSign(url, params);
    const res = await request(app)
      .post(`/v1/wa-webhooks/${owner.id}`)
      .set('host', '127.0.0.1')
      .set('x-twilio-signature', sig)
      .type('form')
      .send(params);
    expect(res.text).toMatch(/<Response\s*\/>/);
    expect(res.headers['content-type']).toMatch(/xml/i);
  });
});
