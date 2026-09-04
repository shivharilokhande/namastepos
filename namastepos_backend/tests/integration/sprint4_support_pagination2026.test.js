// Sprint 4 (2026-09-03) — NP-143 admin support-ticket list pagination.
//
// listTickets was unbounded (every ticket on every load) and counted messages
// with a correlated per-row subquery. Now: limit/offset (default 50, max 200,
// clamped in the service), `total` via COUNT(*) OVER(), and message counts
// from one grouped join. Response stays backward-compatible: `tickets` is
// still the array; `total` is added.

const request = require('supertest');
const buildApp = require('../../src/app');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');
const support = require('../../src/services/supportService');
const adminTeam = require('../../src/services/adminTeamService');

let app; let biz1; let biz2; let ownerToken; let
  adminToken;
const ticketIds = {}; // subject → id

beforeAll(async () => {
  await resetDb();
  app = buildApp();
  biz1 = await makeBusiness({ email: 'support-pg-1@example.com', name: 'Pager Cafe' });
  biz2 = await makeBusiness({ email: 'support-pg-2@example.com', name: 'Other Dhaba' });
  ownerToken = tokenFor(biz1);

  // 5 tickets on biz1 + 1 on biz2 (all priority normal, status open).
  for (let n = 1; n <= 5; n++) {
    const t = await support.createTicket({
      businessId: biz1.id, subject: `T${n}`, body: `first message ${n}`,
    });
    ticketIds[`T${n}`] = t.id;
  }
  const other = await support.createTicket({
    businessId: biz2.id, subject: 'OTHER', body: 'other biz ticket',
  });
  ticketIds.OTHER = other.id;

  // Vary message counts: T1 → 3 messages, T2 → 2, rest → 1 (the opener).
  await support.addMessage(ticketIds.T1, { body: 'reply a', authorType: 'tenant' });
  await support.addMessage(ticketIds.T1, { body: 'reply b', authorType: 'tenant' });
  await support.addMessage(ticketIds.T2, { body: 'reply c', authorType: 'tenant' });

  // Real admin (support role has customers.*) — matches production auth path.
  await adminTeam.create({
    email: 'pager-admin@namastepos.in',
    password: 'secret123-strong',
    displayName: 'Pager Admin',
    role: 'support',
  });
  const login = await adminTeam.login('pager-admin@namastepos.in', 'secret123-strong');
  adminToken = login.token;
});

afterAll(async () => { await closePool(); });

const asAdmin = () => ({ Authorization: `Bearer ${adminToken}` });

describe('NP-143 — admin support list pagination', () => {
  it('respects limit and returns the full total', async () => {
    const r = await request(app)
      .get('/v1/admin/support/tickets?limit=3&offset=0')
      .set(asAdmin());
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.tickets)).toBe(true); // shape unchanged
    expect(r.body.tickets.length).toBe(3);
    expect(r.body.total).toBe(6);
  });

  it('pages are disjoint, cover every ticket, and keep the same total', async () => {
    const p1 = await request(app)
      .get('/v1/admin/support/tickets?limit=3&offset=0').set(asAdmin());
    const p2 = await request(app)
      .get('/v1/admin/support/tickets?limit=3&offset=3').set(asAdmin());
    expect(p1.status).toBe(200);
    expect(p2.status).toBe(200);
    expect(p2.body.total).toBe(6);
    const ids = [...p1.body.tickets, ...p2.body.tickets].map((t) => t.id);
    expect(new Set(ids).size).toBe(6); // no row repeated across pages
    expect(ids.sort()).toEqual(Object.values(ticketIds).sort());
  });

  it('message counts survive the grouped-join rewrite', async () => {
    const r = await request(app)
      .get('/v1/admin/support/tickets?limit=200').set(asAdmin());
    expect(r.status).toBe(200);
    const bySubject = Object.fromEntries(r.body.tickets.map((t) => [t.subject, t]));
    expect(bySubject.T1.messageCount).toBe(3);
    expect(bySubject.T2.messageCount).toBe(2);
    expect(bySubject.T3.messageCount).toBe(1);
    expect(bySubject.OTHER.messageCount).toBe(1);
  });

  it('defaults apply when no limit/offset sent (all 6 fit in default 50)', async () => {
    const r = await request(app).get('/v1/admin/support/tickets').set(asAdmin());
    expect(r.status).toBe(200);
    expect(r.body.tickets.length).toBe(6);
    expect(r.body.total).toBe(6);
  });

  it('an over-cap limit is clamped, not an error', async () => {
    const r = await request(app)
      .get('/v1/admin/support/tickets?limit=99999').set(asAdmin());
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(6);
  });

  it('status filter composes with pagination', async () => {
    await support.setStatus(ticketIds.T3, 'closed');
    const r = await request(app)
      .get('/v1/admin/support/tickets?status=closed&limit=50').set(asAdmin());
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(1);
    expect(r.body.tickets[0].id).toBe(ticketIds.T3);
  });

  it('businessId filter composes with pagination', async () => {
    const r = await request(app)
      .get(`/v1/admin/support/tickets?businessId=${biz2.id}&limit=50`).set(asAdmin());
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(1);
    expect(r.body.tickets[0].id).toBe(ticketIds.OTHER);
  });
});

describe('NP-143 — tenant support list stays scoped + backward compatible', () => {
  it('owner sees only their tickets, array shape intact, total added', async () => {
    const r = await request(app)
      .get(`/v1/businesses/${biz1.id}/support?limit=2&offset=0`)
      .set({ Authorization: `Bearer ${ownerToken}` });
    expect(r.status).toBe(200);
    expect(r.body.tickets.length).toBe(2);
    expect(r.body.total).toBe(5); // biz2's ticket never leaks in
    for (const t of r.body.tickets) expect(t.businessId).toBe(biz1.id);
  });
});
