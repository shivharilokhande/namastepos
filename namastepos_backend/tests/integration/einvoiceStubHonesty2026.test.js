// E-INVOICE / E-WAY BILL HONESTY GATE (2026-09-05)
//
// The bug these tests lock down was not a crash. generateIrn() produced a
// 64-hex-character IRN using the correct NIC algorithm and stored it with
// status 'generated' and an ack_no of `ACK-<epoch>`, having never contacted
// the IRP; ewayBillService did the same with NIC's 12-digit EWB shape. Both
// outputs were indistinguishable from the real thing, on a plan sold partly
// on "e-invoice", to owners who file GST returns.
//
// So the assertions here are about what an owner and a caller can TELL:
//
//   1. production + no IRP credentials  -> refuse, and write NOTHING
//   2. non-production                   -> stub allowed, but branded DEMO in
//                                          the value, the row and the response
//   3. the API says so explicitly       -> isStub / filedWithIrp / notice
//   4. rows written before the gate     -> still marked (migration 093)
//
// The refusal in (1) follows otpService._sendViaMsg91: in prod with no
// provider key, log and throw rather than silently taking the dev path.

const request = require('supertest');
const buildApp = require('../../src/app');
const { query } = require('../../src/config/db');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');
const env = require('../../src/config/env');
const irp = require('../../src/services/irpGateway');
const accountingExport = require('../../src/services/accountingExportService');
const eway = require('../../src/services/ewayBillService');

let app;
let owner;
let token;

const auth = () => ({ Authorization: `Bearer ${token}` });
const url = (p) => `/v1/businesses/${owner.id}${p}`;

/** A settled order to e-invoice. */
async function makeOrder(orderNo) {
  const r = await query(
    `INSERT INTO orders (business_id, order_no, source, status, subtotal, total, payment_method)
     VALUES ($1, $2, 'dineIn', 'collected', 100, 100, 'cash'::payment_method)
     RETURNING id`,
    [owner.id, orderNo],
  );
  return r.rows[0].id;
}

/**
 * env.isProd() reads env.NODE_ENV at call time (see src/config/env.js), so
 * flipping the field is enough — and is restored even if the body throws.
 */
async function asProduction(fn) {
  const prev = env.NODE_ENV;
  env.NODE_ENV = 'production';
  try {
    return await fn();
  } finally {
    env.NODE_ENV = prev;
  }
}

beforeAll(async () => {
  await resetDb();
  app = buildApp();
  owner = await makeBusiness({ email: 'einv-owner@example.com', name: 'E-invoice Test' });
  token = tokenFor(owner);
  // /einvoice is plan-gated on einvoice_gst (featureGate). Grant it so these
  // tests exercise the HONESTY layer rather than the paywall.
  await query(
    `INSERT INTO business_feature_overrides (business_id, feature_key, enabled)
     VALUES ($1, 'einvoice_gst', TRUE)
     ON CONFLICT (business_id, feature_key) DO UPDATE SET enabled = TRUE`,
    [owner.id],
  );
});
afterAll(async () => { await closePool(); });

describe('production with no IRP credentials REFUSES', () => {
  it('generateIrn throws and writes no row', async () => {
    const orderId = await makeOrder(7101);
    // Precondition: this is the production reality — the creds are unset.
    expect(irp.irpConfigured()).toBe(false);

    await asProduction(async () => {
      await expect(accountingExport.generateIrn(owner.id, orderId))
        .rejects.toMatchObject({ statusCode: 503, code: 'IRP_NOT_CONFIGURED' });
    });

    // The point of the test: a refused request leaves NO fabricated IRN
    // behind. The old code inserted first and decided afterwards.
    const rows = await query('SELECT * FROM einvoice_irns WHERE order_id = $1', [orderId]);
    expect(rows.rowCount).toBe(0);
  });

  it('the refusal names the missing configuration rather than failing vaguely', async () => {
    const orderId = await makeOrder(7102);
    await asProduction(async () => {
      const err = await accountingExport.generateIrn(owner.id, orderId).catch((e) => e);
      expect(err.message).toMatch(/not connected to a GSP\/IRP/i);
      expect(err.details.missingEnv).toEqual(['IRP_BASE_URL', 'IRP_USERNAME', 'IRP_PASSWORD']);
    });
  });

  it('e-way bill generation refuses too, and writes no draft row', async () => {
    const before = await query('SELECT COUNT(*)::int AS n FROM eway_bills');
    await asProduction(async () => {
      await expect(eway.generate(owner.id, {
        fromPincode: '400001',
        toPincode: '411001',
        fromState: 'MH',
        toState: 'MH',
        distanceKm: 150,
      })).rejects.toMatchObject({ statusCode: 503, code: 'IRP_NOT_CONFIGURED' });
    });
    const after = await query('SELECT COUNT(*)::int AS n FROM eway_bills');
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('the accounting-export flavour of e-way bill refuses as well', async () => {
    await asProduction(async () => {
      await expect(accountingExport.generateEwayBill(owner.id, null, { vehicleNo: 'MH01AB1234', distanceKm: 10 }))
        .rejects.toMatchObject({ statusCode: 503, code: 'IRP_NOT_CONFIGURED' });
    });
  });
});

describe('outside production the stub is allowed but UNMISTAKABLE', () => {
  it('brands the IRN value itself so it cannot be pasted into a filing', async () => {
    const orderId = await makeOrder(7201);
    const rec = await accountingExport.generateIrn(owner.id, orderId);

    expect(rec.irn.startsWith(irp.STUB_IRN_PREFIX)).toBe(true);
    // A real IRN is exactly 64 hex characters. This is neither.
    expect(rec.irn).not.toMatch(/^[0-9a-f]{64}$/);
    expect(rec.irn.length).not.toBe(64);
  });

  it('marks the stored row, not just the value', async () => {
    const orderId = await makeOrder(7202);
    await accountingExport.generateIrn(owner.id, orderId);

    const row = (await query('SELECT * FROM einvoice_irns WHERE order_id = $1', [orderId])).rows[0];
    expect(row.is_stub).toBe(true);
    expect(row.status).toBe('demo');
    // `ACK-<epoch>` used to read as a real IRP acknowledgement.
    expect(row.ack_no).toBe('DEMO-NOT-ACKNOWLEDGED');
    expect(row.raw_response.stub).toBe(true);
    expect(row.raw_response.filedWithIrp).toBe(false);
    expect(row.raw_response.notice).toMatch(/not filed with the government IRP/i);
  });

  it('brands the e-way bill number the same way', async () => {
    const bill = await eway.generate(owner.id, {
      fromPincode: '400001',
      toPincode: '411001',
      fromState: 'MH',
      toState: 'MH',
      distanceKm: 150,
    });
    expect(bill.ewb_no.startsWith(irp.STUB_EWB_PREFIX)).toBe(true);
    // A NIC EWB number is 12 digits. This is neither 12 characters nor digits.
    expect(bill.ewb_no).not.toMatch(/^\d{12}$/);
    expect(bill.is_stub).toBe(true);
    expect(bill.isStub).toBe(true);
    expect(bill.filedWithNic).toBe(false);
    expect(bill.status).toBe('demo');
  });

  it('refuses rather than stubbing once IRP credentials ARE set (no silent fallback)', async () => {
    const orderId = await makeOrder(7203);
    const prev = env.IRP_BASE_URL;
    const prevU = env.IRP_USERNAME;
    const prevP = env.IRP_PASSWORD;
    env.IRP_BASE_URL = 'https://einvoice1.gst.gov.in';
    env.IRP_USERNAME = 'u';
    env.IRP_PASSWORD = 'p';
    try {
      await expect(accountingExport.generateIrn(owner.id, orderId))
        .rejects.toMatchObject({ statusCode: 501, code: 'IRP_NOT_IMPLEMENTED' });
    } finally {
      env.IRP_BASE_URL = prev;
      env.IRP_USERNAME = prevU;
      env.IRP_PASSWORD = prevP;
    }
    const rows = await query('SELECT * FROM einvoice_irns WHERE order_id = $1', [orderId]);
    expect(rows.rowCount).toBe(0);
  });
});

describe('the API tells the caller', () => {
  it('POST /einvoice/:orderId exposes the stub status on the record AND the envelope', async () => {
    const orderId = await makeOrder(7301);
    const r = await request(app).post(url(`/einvoice/${orderId}`)).set(auth());
    expect(r.status).toBe(201);

    // Envelope — a client rendering body.irn without inspecting it still
    // cannot show a DEMO number as final.
    expect(r.body.stub).toBe(true);
    expect(r.body.filedWithIrp).toBe(false);

    // Record.
    expect(r.body.irn.isStub).toBe(true);
    expect(r.body.irn.filedWithIrp).toBe(false);
    expect(r.body.irn.notice).toMatch(/must never be used in a return/i);
    expect(r.body.irn.irn).toContain('DEMO');
  });

  it('GET /einvoice carries the flag on every listed record', async () => {
    const r = await request(app).get(url('/einvoice')).set(auth());
    expect(r.status).toBe(200);
    expect(r.body.irns.length).toBeGreaterThan(0);
    for (const rec of r.body.irns) {
      expect(rec.isStub).toBe(true);
      expect(rec.filedWithIrp).toBe(false);
      expect(typeof rec.notice).toBe('string');
    }
  });

  it('POST /eway-bills exposes it too', async () => {
    const r = await request(app).post(url('/eway-bills')).set(auth()).send({
      fromPincode: '400001',
      toPincode: '411001',
      fromState: 'MH',
      toState: 'MH',
      distanceKm: 150,
    });
    expect(r.status).toBe(201);
    expect(r.body.stub).toBe(true);
    expect(r.body.isStub).toBe(true);
    expect(r.body.filedWithNic).toBe(false);
    expect(r.body.ewb_no).toContain('DEMO');
  });
});

describe('migration 093 — existing rows are marked, never rewritten', () => {
  it('defaults new rows to NOT stub, so a real IRP row is never mis-marked', async () => {
    // The column was added with DEFAULT TRUE (which backfilled every row that
    // existed) and then flipped to DEFAULT FALSE. This asserts the flip.
    const d = await query(
      `SELECT column_default FROM information_schema.columns
        WHERE table_name = 'einvoice_irns' AND column_name = 'is_stub'`,
    );
    expect(d.rows[0].column_default).toMatch(/false/i);
  });

  it('still reports a DEMO-branded value as a stub even if the flag says otherwise', async () => {
    // Belt and braces: a row restored from a pre-093 backup, or hand-edited,
    // must not be able to present itself as filed.
    const orderId = await makeOrder(7401);
    await query(
      `INSERT INTO einvoice_irns (business_id, order_id, irn, status, is_stub)
       VALUES ($1, $2, $3, 'generated', FALSE)`,
      [owner.id, orderId, `${irp.STUB_IRN_PREFIX}deadbeef`],
    );
    const list = await accountingExport.listIrns(owner.id);
    const rec = list.find((x) => x.orderId === orderId);
    expect(rec.isStub).toBe(true);
    expect(rec.filedWithIrp).toBe(false);
  });
});
