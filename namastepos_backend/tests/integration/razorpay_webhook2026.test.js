// Regression tests for the 2026-09-03 Razorpay webhook hardening sprint.
// Locks in:
//   NP-101 — a yearly checkout (charged against plans.razorpay_plan_id_yearly)
//            flips the subscription onto the paid tier, same as monthly.
//   NP-109 — the dedup key is the `x-razorpay-event-id` HTTP header (Razorpay
//            does not send an event id in the payload body).
//   NP-110 — the dedup gate is a single atomic INSERT ... ON CONFLICT DO
//            NOTHING RETURNING claim; a delivery that loses the claim runs
//            NO side effects.

// Must be set BEFORE any src require — config/env reads it at import time.
process.env.RAZORPAY_WEBHOOK_SECRET = 'test-webhook-secret';

const crypto = require('crypto');
const request = require('supertest');
const buildApp = require('../../src/app');
const { resetDb, makeBusiness, closePool } = require('../setup');
const { query } = require('../../src/config/db');
const razorpayService = require('../../src/services/razorpayService');

let app;

beforeAll(async () => {
  await resetDb();
  app = buildApp();
});
afterAll(async () => { await closePool(); });

function chargedPayload({ subId, planId, payId, amount = 29900 }) {
  return {
    event: 'subscription.charged',
    payload: {
      subscription: { entity: { id: subId, plan_id: planId,
        current_end: Math.floor(Date.now() / 1000) + 365 * 86400 } },
      payment: { entity: { id: payId, amount, method: 'upi' } },
    },
  };
}

describe('NP-101: yearly plan id resolves to the paid tier', () => {
  it('flips plan_id to the paid plan when the charge is against razorpay_plan_id_yearly', async () => {
    const biz = await makeBusiness({ email: `yrly-${Date.now()}` });
    await query(`UPDATE plans SET razorpay_plan_id_yearly = 'plan_YRLY_TEST' WHERE tier = 'pro'`);
    const proPlan = (await query(`SELECT id FROM plans WHERE tier = 'pro'`)).rows[0];
    const freePlan = (await query(`SELECT id FROM plans WHERE tier = 'free'`)).rows[0];
    await query(
      `INSERT INTO subscriptions
         (business_id, plan_id, status, razorpay_subscription_id)
       VALUES ($1, $2, 'active', 'sub_YRLY_TEST')`,
      [biz.id, freePlan.id]
    );

    await razorpayService.handleWebhook(
      chargedPayload({ subId: 'sub_YRLY_TEST', planId: 'plan_YRLY_TEST', payId: `pay-yrly-${Date.now()}` }),
      `evt_yrly_${Date.now()}`
    );

    const sub = (await query(
      `SELECT plan_id, status FROM subscriptions WHERE business_id = $1`, [biz.id]
    )).rows[0];
    expect(sub.plan_id).toBe(proPlan.id); // paid tier granted — no fallback to old plan
    expect(sub.status).toBe('active');
  });
});

describe('NP-109: dedup keys on the x-razorpay-event-id header', () => {
  it('same header event id delivered twice → second delivery is a no-op replay', async () => {
    const biz = await makeBusiness({ email: `dedup-${Date.now()}` });
    await query(`UPDATE plans SET razorpay_plan_id = 'plan_DEDUP_TEST' WHERE tier = 'pro'`);
    const freePlan = (await query(`SELECT id FROM plans WHERE tier = 'free'`)).rows[0];
    await query(
      `INSERT INTO subscriptions
         (business_id, plan_id, status, razorpay_subscription_id)
       VALUES ($1, $2, 'active', 'sub_DEDUP_TEST')`,
      [biz.id, freePlan.id]
    );

    const eventId = `evt_hdr_${Date.now()}`;
    // Real Razorpay payloads carry NO payload.id — only the header has the id.
    const payload = chargedPayload({
      subId: 'sub_DEDUP_TEST', planId: 'plan_DEDUP_TEST', payId: `pay-dedup-${Date.now()}`,
    });

    const first = await razorpayService.handleWebhook(payload, eventId);
    expect(first.eventId).toBe(eventId); // header value is the key, not a synthetic

    const second = await razorpayService.handleWebhook(payload, eventId);
    // Replay: stored response echoed, side effects NOT re-run.
    expect(second).toEqual(first);

    const invoices = (await query(
      `SELECT count(*)::int AS c FROM invoices WHERE business_id = $1`, [biz.id]
    )).rows[0].c;
    expect(invoices).toBe(1);
    const events = (await query(
      `SELECT count(*)::int AS c FROM webhook_events WHERE external_id = $1`, [eventId]
    )).rows[0].c;
    expect(events).toBe(1);
  });

  it('HTTP route threads the header through to the dedup gate', async () => {
    const eventId = `evt_http_${Date.now()}`;
    // Unhandled event type — exercises the id/dedup plumbing with no side effects.
    const raw = JSON.stringify({ event: 'np109.header.test', payload: {} });
    const sig = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(raw).digest('hex');

    const r = await request(app)
      .post('/v1/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', sig)
      .set('x-razorpay-event-id', eventId)
      .send(raw);
    expect(r.status).toBe(200);
    expect(r.body.eventId).toBe(eventId); // header reached the service

    const row = (await query(
      `SELECT count(*)::int AS c FROM webhook_events WHERE external_id = $1`, [eventId]
    )).rows[0].c;
    expect(row).toBe(1);
  });
});

describe('NP-110: dedup claim is atomic (zero-rowCount path)', () => {
  it('a delivery that loses the INSERT claim runs no side effects', async () => {
    const biz = await makeBusiness({ email: `atomic-${Date.now()}` });
    await query(`UPDATE plans SET razorpay_plan_id = 'plan_ATOMIC_TEST' WHERE tier = 'pro'`);
    const freePlan = (await query(`SELECT id FROM plans WHERE tier = 'free'`)).rows[0];
    await query(
      `INSERT INTO subscriptions
         (business_id, plan_id, status, razorpay_subscription_id)
       VALUES ($1, $2, 'active', 'sub_ATOMIC_TEST')`,
      [biz.id, freePlan.id]
    );

    const eventId = `evt_atomic_${Date.now()}`;
    // Simulate a concurrent first delivery that has already claimed the row
    // but not yet finished (response_body still NULL).
    await query(
      `INSERT INTO webhook_events (provider, external_id, event_type, payload)
       VALUES ('razorpay', $1, 'subscription.charged', '{}'::jsonb)`,
      [eventId]
    );

    const result = await razorpayService.handleWebhook(
      chargedPayload({ subId: 'sub_ATOMIC_TEST', planId: 'plan_ATOMIC_TEST', payId: `pay-atomic-${Date.now()}` }),
      eventId
    );
    // Loser must NOT ack while the winner is in flight: pending → controller
    // maps to HTTP 409 so Razorpay retries (winner may still fail and release
    // the dedup row for a genuine retry).
    expect(result).toEqual({ received: false, pending: true, replayed: true });

    // And NONE of the charge side effects ran.
    const sub = (await query(
      `SELECT plan_id FROM subscriptions WHERE business_id = $1`, [biz.id]
    )).rows[0];
    expect(sub.plan_id).toBe(freePlan.id); // not upgraded
    const invoices = (await query(
      `SELECT count(*)::int AS c FROM invoices WHERE business_id = $1`, [biz.id]
    )).rows[0].c;
    expect(invoices).toBe(0);
  });
});
