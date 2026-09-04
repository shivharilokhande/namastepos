// Regression test for the 2026-08-30 guest membership-benefit OTP fix.
// The vulnerability: benefitVerify minted the benefit token from the
// CLIENT-supplied phone and never checked the OTP's purpose/business, so any
// OTP an attacker could complete let them mint a token for a victim's phone.
// The fix binds the token to the OTP-verified phone and requires
// purpose==='guest_benefit' + meta.businessId===businessId.

const request = require('supertest');
const bcrypt = require('bcryptjs');
const { resetDb, makeBusiness, closePool } = require('../setup');
const { query } = require('../../src/config/db');
const qrService = require('../../src/services/qrService');
const tableService = require('../../src/services/tableService');

let app; let token; let
  businessId;

beforeAll(async () => {
  await resetDb();
  app = require('../../src/app')();
  const biz = await makeBusiness({ email: `gb-${Date.now()}` });
  businessId = biz.id;
  const floor = (await query(
    'INSERT INTO floors (business_id, name) VALUES ($1, \'Ground\') RETURNING id',
    [businessId],
  )).rows[0];
  const table = await tableService.createTable(businessId, { floorId: floor.id, label: 'T1', seats: 4 });
  token = await qrService.issueTokenForTable(businessId, table.id);
  await query('UPDATE tables SET qr_enabled = TRUE WHERE id = $1', [table.id]);
});
afterAll(async () => { await closePool(); });

async function seedOtp({ phone, purpose, meta, code = '123456' }) {
  const hash = await bcrypt.hash(code, 8);
  return (await query(
    `INSERT INTO otp_requests (phone, purpose, code_hash, expires_at, meta)
     VALUES ($1, $2, $3, NOW() + INTERVAL '10 min', $4::jsonb) RETURNING id`,
    [phone, purpose, hash, JSON.stringify(meta || {})],
  )).rows[0].id;
}

describe('Guest benefit OTP verify', () => {
  it('rejects an OTP whose purpose is not guest_benefit', async () => {
    const id = await seedOtp({ phone: '9800000001', purpose: 'signin', meta: { businessId } });
    const r = await request(app)
      .post(`/v1/guest/benefit/verify/${token}`)
      .send({ requestId: id, code: '123456', phone: '9800000001' });
    expect(r.status).toBe(400);
    expect(r.body.benefitToken).toBeUndefined();
  });

  it('rejects a guest_benefit OTP minted for a DIFFERENT business', async () => {
    const id = await seedOtp({ phone: '9800000002', purpose: 'guest_benefit', meta: { businessId: 'other-biz' } });
    const r = await request(app)
      .post(`/v1/guest/benefit/verify/${token}`)
      .send({ requestId: id, code: '123456', phone: '9800000002' });
    expect(r.status).toBe(400);
  });

  it('mints a benefit token for a valid guest_benefit OTP of this business', async () => {
    const id = await seedOtp({ phone: '9800000003', purpose: 'guest_benefit', meta: { businessId } });
    const r = await request(app)
      .post(`/v1/guest/benefit/verify/${token}`)
      .send({ requestId: id, code: '123456', phone: '9800000003' });
    expect(r.status).toBe(200);
    expect(typeof r.body.benefitToken).toBe('string');
    expect(r.body.benefitToken.length).toBeGreaterThan(10);
  });
});
