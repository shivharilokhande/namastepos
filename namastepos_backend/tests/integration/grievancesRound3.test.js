// Round 3 (2026-09-06) — founder Bug 3: super-admin Compliance → Grievances.
//
// Exercises the admin grievance desk end to end as the console drives it:
// list (filters), create (out-of-band complaint), detail, status transition
// (SLA timestamps), assignment, internal notes, RBAC (finance = read-only,
// sales = nothing, tenant token refused) and validation.

const request = require('supertest');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');
const { query } = require('../../src/config/db');
const { issueAccessToken } = require('../../src/utils/jwt');
const buildApp = require('../../src/app');

let app;
let biz;
let superToken;
let supportToken;
let financeToken;
let salesToken;
let supportAdminId;

// requirePermission resolves the role LIVE from admin_users — the row must exist.
async function makeAdmin(email, role) {
  const r = await query(
    `INSERT INTO admin_users (email, password_hash, role, is_active)
     VALUES ($1, 'x-not-a-real-hash', $2, TRUE) RETURNING id, email, role`,
    [email, role],
  );
  return {
    id: r.rows[0].id,
    token: issueAccessToken({
      sid: r.rows[0].id, isSuperAdmin: true, email: r.rows[0].email, role: r.rows[0].role,
    }),
  };
}
// Admin API is cookie-only (ff_admin); Bearer is sent too so a TENANT token
// can be shown to be refused on /admin.
const as = (t) => ({ Authorization: `Bearer ${t}`, Cookie: `ff_admin=${t}` });

async function filePublic(subject, extra = {}) {
  const r = await request(app).post('/v1/compliance/grievance').send({
    complainantEmail: 'diner@example.com',
    category: 'privacy',
    subject,
    body: 'Please delete my data.',
    ...extra,
  });
  expect(r.status).toBe(201);
  return r.body.id;
}

beforeAll(async () => {
  await resetDb();
  app = buildApp();
  biz = await makeBusiness({ email: `r3-grv-${Date.now()}`, name: 'Grievance Cafe' });
  const sup = await makeAdmin(`sup-${Date.now()}@namastepos.in`, 'super_admin');
  superToken = sup.token;
  const support = await makeAdmin(`support-${Date.now()}@namastepos.in`, 'support');
  supportToken = support.token;
  supportAdminId = support.id;
  financeToken = (await makeAdmin(`fin-${Date.now()}@namastepos.in`, 'finance')).token;
  salesToken = (await makeAdmin(`sales-${Date.now()}@namastepos.in`, 'sales')).token;
});
afterAll(async () => { await closePool(); });

describe('GET /v1/admin/compliance/grievances', () => {
  let idA; let idB;
  beforeAll(async () => {
    idA = await filePublic('Public complaint A', { businessId: biz.id });
    idB = await filePublic('Public complaint B');
  });

  it('lists as super_admin with the console shape', async () => {
    const r = await request(app).get('/v1/admin/compliance/grievances').set(as(superToken));
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.grievances)).toBe(true);
    const a = r.body.grievances.find((g) => g.id === idA);
    expect(a).toEqual(expect.objectContaining({
      businessId: biz.id,
      businessName: 'Grievance Cafe',
      complainantEmail: 'diner@example.com',
      category: 'privacy',
      subject: 'Public complaint A',
      status: 'received',
      assignedTo: null,
      noteCount: 0,
    }));
    expect(typeof a.ackDueAt).toBe('string');
    expect(typeof a.resolveDueAt).toBe('string');
    expect(typeof a.createdAt).toBe('string');
  });

  it('filters by status and businessId; rejects an unknown status', async () => {
    const byBiz = await request(app).get('/v1/admin/compliance/grievances')
      .query({ businessId: biz.id }).set(as(superToken));
    expect(byBiz.body.grievances.map((g) => g.id)).toContain(idA);
    expect(byBiz.body.grievances.map((g) => g.id)).not.toContain(idB);
    const rec = await request(app).get('/v1/admin/compliance/grievances')
      .query({ status: 'received' }).set(as(superToken));
    expect(rec.status).toBe(200);
    const bad = await request(app).get('/v1/admin/compliance/grievances')
      .query({ status: 'bogus' }).set(as(superToken));
    expect(bad.status).toBe(400);
  });

  it('finance (compliance.read) can list; sales cannot; a tenant owner token is refused', async () => {
    expect((await request(app).get('/v1/admin/compliance/grievances').set(as(financeToken))).status).toBe(200);
    expect((await request(app).get('/v1/admin/compliance/grievances').set(as(salesToken))).status).toBe(403);
    const tenant = await request(app).get('/v1/admin/compliance/grievances').set(as(tokenFor(biz)));
    expect([401, 403]).toContain(tenant.status);
  });
});

describe('POST /v1/admin/compliance/grievances (admin-side filing)', () => {
  it('creates an out-of-band complaint with an opening note and assignment', async () => {
    const r = await request(app).post('/v1/admin/compliance/grievances').set(as(supportToken)).send({
      businessId: biz.id,
      complainantName: 'Ravi',
      complainantPhone: '9876543210',
      category: 'billing',
      subject: 'Charged twice on wallet',
      body: 'Customer called the helpline.',
      assignedTo: supportAdminId,
      note: 'Called back, awaiting screenshot.',
    });
    expect(r.status).toBe(201);
    expect(r.body.grievance).toEqual(expect.objectContaining({
      businessId: biz.id,
      complainantName: 'Ravi',
      complainantPhone: '9876543210',
      category: 'billing',
      status: 'received',
      assignedTo: supportAdminId,
      noteCount: 1,
    }));
    expect(r.body.notes).toHaveLength(1);
    expect(r.body.notes[0]).toEqual(expect.objectContaining({
      body: 'Called back, awaiting screenshot.', adminId: supportAdminId,
    }));
  });

  it('400 without any complainant contact, without subject, or with a bad category', async () => {
    const base = { category: 'other', subject: 'x y z', body: 'some body text' };
    const noContact = await request(app).post('/v1/admin/compliance/grievances').set(as(superToken)).send(base);
    expect(noContact.status).toBe(400);
    const noSubject = await request(app).post('/v1/admin/compliance/grievances').set(as(superToken))
      .send({ complainantEmail: 'a@b.com', category: 'other', body: 'some body text' });
    expect(noSubject.status).toBe(400);
    const badCat = await request(app).post('/v1/admin/compliance/grievances').set(as(superToken))
      .send({ ...base, complainantEmail: 'a@b.com', category: 'nonsense' });
    expect(badCat.status).toBe(400);
  });

  it('finance (read-only) cannot create', async () => {
    const r = await request(app).post('/v1/admin/compliance/grievances').set(as(financeToken))
      .send({ complainantEmail: 'a@b.com', category: 'other', subject: 'x y z', body: 'some body text' });
    expect(r.status).toBe(403);
  });
});

describe('PATCH /v1/admin/compliance/grievances/:id', () => {
  let id;
  beforeAll(async () => { id = await filePublic('Transition me'); });

  it('received → acknowledged stamps acknowledgedAt and handledBy; returns the full row', async () => {
    const r = await request(app).patch(`/v1/admin/compliance/grievances/${id}`).set(as(supportToken))
      .send({ status: 'acknowledged' });
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(id);
    expect(r.body.status).toBe('acknowledged');
    expect(r.body.acknowledgedAt).toBeTruthy();
    expect(r.body.resolvedAt).toBeNull();
    expect(r.body.handledBy).toBe(supportAdminId);
    expect(Array.isArray(r.body.notes)).toBe(true);
  });

  it('assigns without changing status; un-assigns with null; refuses an unknown admin', async () => {
    const a = await request(app).patch(`/v1/admin/compliance/grievances/${id}`).set(as(superToken))
      .send({ assignedTo: supportAdminId });
    expect(a.status).toBe(200);
    expect(a.body.status).toBe('acknowledged');
    expect(a.body.assignedTo).toBe(supportAdminId);
    expect(a.body.assignedToEmail).toMatch(/^support-/);
    const byAssignee = await request(app).get('/v1/admin/compliance/grievances')
      .query({ assignedTo: supportAdminId }).set(as(superToken));
    expect(byAssignee.body.grievances.map((g) => g.id)).toContain(id);
    const bogus = await request(app).patch(`/v1/admin/compliance/grievances/${id}`).set(as(superToken))
      .send({ assignedTo: '00000000-0000-4000-8000-000000000000' });
    expect(bogus.status).toBe(400);
    const un = await request(app).patch(`/v1/admin/compliance/grievances/${id}`).set(as(superToken))
      .send({ assignedTo: null });
    expect(un.status).toBe(200);
    expect(un.body.assignedTo).toBeNull();
  });

  it('appends internal notes via PATCH {note} and POST /:id/notes; detail lists them newest first', async () => {
    const p = await request(app).patch(`/v1/admin/compliance/grievances/${id}`).set(as(supportToken))
      .send({ note: 'First internal note' });
    expect(p.status).toBe(200);
    expect(p.body.noteCount).toBe(1);
    const n = await request(app).post(`/v1/admin/compliance/grievances/${id}/notes`).set(as(superToken))
      .send({ body: 'Second internal note' });
    expect(n.status).toBe(201);
    expect(n.body.note.body).toBe('Second internal note');
    const d = await request(app).get(`/v1/admin/compliance/grievances/${id}`).set(as(financeToken));
    expect(d.status).toBe(200);
    expect(d.body.grievance.id).toBe(id);
    expect(d.body.grievance.noteCount).toBe(2);
    expect(d.body.notes.map((x) => x.body)).toEqual(['Second internal note', 'First internal note']);
    expect(d.body.notes[1].adminId).toBe(supportAdminId);
  });

  it('acknowledged → resolved stamps resolvedAt and keeps the resolution note', async () => {
    const r = await request(app).patch(`/v1/admin/compliance/grievances/${id}`).set(as(superToken))
      .send({ status: 'resolved', resolutionNote: 'Data erased; confirmation sent.' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('resolved');
    expect(r.body.resolvedAt).toBeTruthy();
    expect(r.body.resolutionNote).toBe('Data erased; confirmation sent.');
    const row = (await query('SELECT status, resolved_at FROM grievance_complaints WHERE id = $1', [id])).rows[0];
    expect(row.status).toBe('resolved');
    expect(row.resolved_at).not.toBeNull();
  });

  it('400 on an empty body or a bad status; 404 on an unknown id; 403 for finance', async () => {
    expect((await request(app).patch(`/v1/admin/compliance/grievances/${id}`).set(as(superToken))
      .send({})).status).toBe(400);
    expect((await request(app).patch(`/v1/admin/compliance/grievances/${id}`).set(as(superToken))
      .send({ status: 'nope' })).status).toBe(400);
    expect((await request(app).patch('/v1/admin/compliance/grievances/00000000-0000-4000-8000-000000000001')
      .set(as(superToken)).send({ status: 'acknowledged' })).status).toBe(404);
    expect((await request(app).patch(`/v1/admin/compliance/grievances/${id}`).set(as(financeToken))
      .send({ status: 'escalated' })).status).toBe(403);
  });

  it('every write lands on the admin audit trail', async () => {
    const r = await query(
      `SELECT action FROM audit_log
        WHERE entity_type = 'grievance' AND entity_id = $1
        ORDER BY created_at`,
      [id],
    );
    expect(r.rows.map((x) => x.action)).toEqual(expect.arrayContaining(['grievance-update', 'grievance-note']));
  });
});
