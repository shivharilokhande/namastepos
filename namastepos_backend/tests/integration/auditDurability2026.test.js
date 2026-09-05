// The audit row must exist BEFORE the client is told the action succeeded.
//
// Regression for CI run 33964654257 (2026-09-05). `middlewareLog` wrapped the
// synchronous `res.json` and called `log()` without awaiting it, so a mutation
// answered 201 while its audit INSERT was still in flight. The row normally
// landed a few milliseconds later, which is why the whole suite passed on a
// fast local database and failed on the CI runner: `mark-paid` returned 201,
// the next test read audit_log, and the row was not there yet.
//
// The bug was never really about a flaky test. An audit trail whose writes are
// fire-and-forget can also lose rows outright — the error was swallowed by a
// bare `catch (_) {}`, and a process exiting between the response and the
// INSERT drops the record with nothing anywhere to say so.
//
// This mounts the middleware on a throwaway express app rather than hunting
// for a production route that happens to be audited. That keeps the test
// about the guarantee itself, so it cannot start passing for an unrelated
// reason (a route moving, a plan gate changing) or start failing for one.

const express = require('express');
const request = require('supertest');
const { query } = require('../../src/config/db');
const { resetDb, makeBusiness } = require('../setup');
const audit = require('../../src/services/auditService');
const logger = require('../../src/config/logger');

describe('audit log durability', () => {
  let biz;

  beforeAll(async () => {
    await resetDb();
    biz = await makeBusiness({ email: 'audit-durability@example.com' });
  });

  function appWith(middleware) {
    const app = express();
    app.use(express.json());
    app.post('/thing/:businessId', middleware, (req, res) => {
      res.status(201).json({ ok: true });
    });
    return app;
  }

  it('an admin mutation is not acknowledged until its audit row is committed', async () => {
    const app = appWith(
      audit.middlewareLog('durability', 'admin-act', (req) => ({
        type: 'business', id: req.params.businessId,
      })),
    );

    const res = await request(app).post(`/thing/${biz.id}`).send({ x: 1 });
    expect(res.status).toBe(201);

    // No polling and no timer: the row must ALREADY be there the instant the
    // response resolves. This is the assertion the old code could not satisfy.
    const r = await query(
      `SELECT action FROM audit_log
        WHERE module = 'durability' AND action = 'admin-act' AND business_id = $1`,
      [biz.id],
    );
    expect(r.rowCount).toBe(1);
  });

  it('a tenant mutation is not acknowledged until its audit row is committed', async () => {
    const app = appWith(
      audit.tenantMiddlewareLog('durability', 'tenant-act', (req) => ({
        type: 'business', id: req.params.businessId,
      })),
    );

    const res = await request(app).post(`/thing/${biz.id}`).send({ x: 1 });
    expect(res.status).toBe(201);

    const r = await query(
      `SELECT action FROM audit_log
        WHERE module = 'durability' AND action = 'tenant-act' AND business_id = $1`,
      [biz.id],
    );
    expect(r.rowCount).toBe(1);
  });

  it('the send is deferred, not merely usually-late', async () => {
    // The two tests above assert the right thing but can pass by luck: on a
    // fast local database a fire-and-forget INSERT often lands before the next
    // query anyway. That luck is exactly what let the original bug through
    // every local run and only bite on the slower CI runner, so it must not be
    // what guards against it.
    //
    // This asserts the ordering itself rather than any timing. The middleware
    // wraps res.json; calling the wrapper must NOT reach the underlying send
    // synchronously. Fire-and-forget fails this 100% of the time and awaiting
    // the write passes it 100% of the time, on any machine at any speed.
    const mw = audit.middlewareLog('durability', 'ordering', (req) => ({
      type: 'business', id: req.params.businessId,
    }));

    let sent = false;
    const res = {
      statusCode: 201,
      json(body) { sent = true; return { body }; },
    };
    const req = {
      params: { businessId: biz.id },
      body: { x: 1 },
      headers: {},
      ip: '127.0.0.1',
    };

    mw(req, res, () => {});
    res.json({ ok: true });

    // The crux: the underlying send has not happened yet.
    expect(sent).toBe(false);

    // And it does happen, once the write settles.
    const deadline = Date.now() + 5000;
    /* eslint-disable no-await-in-loop */
    while (!sent && Date.now() < deadline) {
      await new Promise((r) => { setTimeout(r, 10); });
    }
    /* eslint-enable no-await-in-loop */
    expect(sent).toBe(true);

    const r = await query(
      `SELECT action FROM audit_log
        WHERE module = 'durability' AND action = 'ordering' AND business_id = $1`,
      [biz.id],
    );
    expect(r.rowCount).toBe(1);
  });

  it('a 4xx writes no audit row and still sends the body', async () => {
    const app = express();
    app.use(express.json());
    app.post(
      '/thing/:businessId',
      audit.middlewareLog('durability', 'rejected', () => ({})),
      (req, res) => res.status(400).json({ error: 'nope' }),
    );

    const res = await request(app).post(`/thing/${biz.id}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('nope');

    const r = await query(
      "SELECT 1 FROM audit_log WHERE module = 'durability' AND action = 'rejected'",
    );
    expect(r.rowCount).toBe(0);
  });

  it('a failing audit write is logged, not silently dropped', async () => {
    // The swallow is deliberate — a restaurant mid-service must not get a 500
    // because the audit table is unhappy. What was wrong was that it swallowed
    // *silently*, so the trail could stop recording and still look complete.
    const spy = jest.spyOn(logger, 'error').mockImplementation(() => {});

    // entity_id is VARCHAR(100) (001_init_schema.sql:196), so an over-long
    // value makes the INSERT throw for a reason that cannot quietly stop being
    // an error the way a bad-uuid guess would.
    await expect(audit.log({
      module: 'durability',
      action: 'deliberate-failure',
      entityType: 'business',
      entityId: 'x'.repeat(200),
      businessId: biz.id,
    })).resolves.toBeUndefined(); // swallowed: the caller is unaffected

    // Search every call, don't index [0]: src/config/db logs its own "Query
    // failed" first, so the audit line is not the first one through the spy.
    // Winston is (message, meta), not pino's (obj, msg).
    const ours = spy.mock.calls.find(
      ([message]) => /audit_log write failed/.test(String(message)),
    );
    expect(ours).toBeDefined();
    expect(ours[1]).toMatchObject({ module: 'durability', action: 'deliberate-failure' });
    spy.mockRestore();

    const r = await query(
      "SELECT 1 FROM audit_log WHERE action = 'deliberate-failure'",
    );
    expect(r.rowCount).toBe(0);
  });
});
