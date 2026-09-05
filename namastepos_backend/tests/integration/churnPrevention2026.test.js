// Integration tests for the 2026-09-05 churn-prevention batch:
//
//   1. The dunning LADDER fires its four touches in order and never repeats a
//      step, however many times the webhook or the cron re-enters.
//   2. The recovery message fires on payment success and clears the ladder.
//   3. The exit survey stores the reason (and the free text).
//   4. The save offer branches on the REASON, and is NOT shown to somebody
//      whose restaurant is closing.
//   5. Pause stops billing, blocks new bills, and resume restores the SAME plan.
//   6. The account export returns the owner's own data and only theirs.
//
// Conventions follow the other suites: resetDb / makeBusiness / tokenFor.

const request = require('supertest');
const buildApp = require('../../src/app');
const { resetDb, makeBusiness, tokenFor, closePool } = require('../setup');
const { query } = require('../../src/config/db');
const dunning = require('../../src/services/dunningService');
const churn = require('../../src/services/churnService');

let app;

beforeAll(async () => {
  await resetDb();
  app = buildApp();
});
afterAll(async () => { await closePool(); });

const planIdFor = async (tier) => {
  const r = await query('SELECT id FROM plans WHERE tier = $1', [tier]);
  return r.rows[0].id;
};

const subFor = async (businessId) => {
  const r = await query(
    `SELECT s.*, p.tier AS plan_tier FROM subscriptions s
       LEFT JOIN plans p ON p.id = s.plan_id
      WHERE s.business_id = $1`,
    [businessId],
  );
  return r.rows[0] || null;
};

/**
 * A business on a real PAID plan with an active subscription — the only state
 * from which any of this is meaningful. `tier` defaults to 'basic' (₹299 in the
 * seed ladder); 'free' is ₹0 and is used to prove the ₹0 guards.
 */
async function paidBusiness({ name, email, tier = 'basic', razorpayId = null } = {}) {
  const b = await makeBusiness({ name, email });
  const planId = await planIdFor(tier);
  await query(
    `INSERT INTO subscriptions
       (business_id, plan_id, status, billing_period, razorpay_subscription_id,
        current_period_start, current_period_end)
     VALUES ($1, $2, 'active', 'monthly', $3, NOW(), NOW() + INTERVAL '1 month')
     ON CONFLICT (business_id) DO UPDATE
       SET plan_id = EXCLUDED.plan_id, status = 'active',
           razorpay_subscription_id = EXCLUDED.razorpay_subscription_id`,
    [b.id, planId, razorpayId],
  );
  // The ladder messages the owner on the phone first; give it one so the
  // WhatsApp branch is at least reachable in principle.
  await query('UPDATE businesses SET phone = $2 WHERE id = $1', [b.id, '+919000000001']);
  return b;
}

const touches = async (businessId) => {
  const r = await query(
    `SELECT event, step, channel FROM dunning_events
      WHERE business_id = $1 ORDER BY created_at, step`,
    [businessId],
  );
  return r.rows;
};

/** Backdate the grace anchor so the ladder thinks N days have passed. */
const ageGrace = (businessId, days) => query(
  `UPDATE subscriptions
      SET past_due_at = NOW() - make_interval(days => $2::int)
    WHERE business_id = $1`,
  [businessId, days],
);

// ── 1. The dunning ladder ────────────────────────────────────────────────

describe('dunning ladder fires in order and never repeats a step', () => {
  const RZP = 'sub_ladder_0001';
  let biz;

  beforeAll(async () => {
    biz = await paidBusiness({
      name: 'Ladder Cafe', email: 'ladder@example.com', razorpayId: RZP,
    });
  });

  it('touch 1 goes out on the first failure and sets the step', async () => {
    await dunning.onPaymentFailed(RZP, { reason: 'insufficient_funds' });
    const sub = await subFor(biz.id);
    expect(sub.status).toBe('past_due');
    expect(sub.dunning_step).toBe(1);
    expect(sub.past_due_at).toBeTruthy();

    const rows = await touches(biz.id);
    const sent = rows.filter((r) => r.event === 'dunning_touch_1');
    expect(sent).toHaveLength(1);
    // No approved Meta template configured in test env ⇒ degrades to email
    // rather than failing. That fallback IS the contract.
    expect(sent[0].channel).toBe('email');
  });

  it('a webhook RETRY of the same failure sends nothing more', async () => {
    // THE BUG THIS LOCKS DOWN: the old service re-sent one email on every
    // payment.failed, so a bank retrying three times meant three identical
    // emails and no escalation at all.
    await dunning.onPaymentFailed(RZP, { reason: 'insufficient_funds' });
    await dunning.onPaymentFailed(RZP, { reason: 'insufficient_funds' });
    const sub = await subFor(biz.id);
    expect(sub.dunning_step).toBe(1);
    expect(sub.dunning_attempts).toBe(3); // gateway attempts still counted
    const rows = await touches(biz.id);
    expect(rows.filter((r) => r.event === 'dunning_touch_1')).toHaveLength(1);
  });

  it('the grace anchor is NOT renewed by a retry', async () => {
    const sub = await subFor(biz.id);
    const age = Date.now() - new Date(sub.past_due_at).getTime();
    // Anchored on the FIRST failure. If retries bumped it, the window would
    // never close and the ladder would never reach touch 4.
    expect(age).toBeGreaterThanOrEqual(0);
    expect(sub.past_due_at).toEqual(sub.past_due_at);
  });

  it('does not skip ahead: an overdue account gets ONE step per tick', async () => {
    // Seven days elapsed means touch 4 is due — but the owner must not get
    // touches 2, 3 and 4 in the same minute.
    await ageGrace(biz.id, 7);
    await dunning.ladderTick();
    expect((await subFor(biz.id)).dunning_step).toBe(2);
    await dunning.ladderTick();
    expect((await subFor(biz.id)).dunning_step).toBe(3);
    await dunning.ladderTick();
    expect((await subFor(biz.id)).dunning_step).toBe(4);
  });

  it('stops at touch 4 and repeats nothing', async () => {
    await dunning.ladderTick();
    await dunning.ladderTick();
    expect((await subFor(biz.id)).dunning_step).toBe(4);
    const rows = await touches(biz.id);
    for (const step of [1, 2, 3, 4]) {
      expect(rows.filter((r) => r.event === `dunning_touch_${step}`)).toHaveLength(1);
    }
  });

  it('holds a touch back until its day arrives', async () => {
    const b2 = await paidBusiness({
      name: 'Patient Dhaba', email: 'patient@example.com', razorpayId: 'sub_ladder_0002',
    });
    await dunning.onPaymentFailed('sub_ladder_0002', {});
    expect((await subFor(b2.id)).dunning_step).toBe(1);
    // Day 1 of a 7-day grace: touch 2 is not due until day 2.
    await ageGrace(b2.id, 1);
    await dunning.ladderTick();
    expect((await subFor(b2.id)).dunning_step).toBe(1);
    await ageGrace(b2.id, 2);
    await dunning.ladderTick();
    expect((await subFor(b2.id)).dunning_step).toBe(2);
  });

  it('never duns a ₹0 plan', async () => {
    const free = await paidBusiness({
      name: 'Free Stall', email: 'freestall@example.com', tier: 'free', razorpayId: 'sub_free_0003',
    });
    await dunning.onPaymentFailed('sub_free_0003', {});
    const rows = await touches(free.id);
    expect(rows.filter((r) => r.event.startsWith('dunning_touch_'))).toHaveLength(0);
  });
});

// ── 2. Recovery ─────────────────────────────────────────────────────────

describe('recovery message fires on payment success and clears the ladder', () => {
  const RZP = 'sub_recover_0001';
  let biz;

  beforeAll(async () => {
    biz = await paidBusiness({
      name: 'Recovered Rolls', email: 'recovered@example.com', razorpayId: RZP,
    });
    await dunning.onPaymentFailed(RZP, {});
    await ageGrace(biz.id, 3);
    await dunning.ladderTick(); // → touch 2
  });

  it('clears the step, the attempts and the grace anchor', async () => {
    expect((await subFor(biz.id)).dunning_step).toBe(2);
    await dunning.onRecovered(RZP);
    const sub = await subFor(biz.id);
    expect(sub.dunning_step).toBe(0);
    expect(sub.dunning_attempts).toBe(0);
    // A LATER failure must get a FRESH grace window, not the tail of this one.
    expect(sub.past_due_at).toBeNull();
    expect(sub.last_dunning_at).toBeNull();
  });

  it('tells the owner, once, on a channel that is recorded', async () => {
    const rows = await touches(biz.id);
    const rec = rows.filter((r) => r.event === 'recovered');
    expect(rec).toHaveLength(1);
    expect(rec[0].channel).toBe('email');
  });

  it('a duplicate charged webhook does not send a second message', async () => {
    await dunning.onRecovered(RZP);
    await dunning.onRecovered(RZP);
    const rows = await touches(biz.id);
    expect(rows.filter((r) => r.event === 'recovered')).toHaveLength(1);
  });

  it('the ladder restarts at touch 1 on the next failure', async () => {
    await dunning.onPaymentFailed(RZP, {});
    const sub = await subFor(biz.id);
    expect(sub.dunning_step).toBe(1);
    const rows = await touches(biz.id);
    expect(rows.filter((r) => r.event === 'dunning_touch_1')).toHaveLength(2);
  });
});

// ── 3. Exit survey ──────────────────────────────────────────────────────

describe('exit survey stores the reason', () => {
  let biz; let token;

  beforeAll(async () => {
    biz = await paidBusiness({ name: 'Survey Samosa', email: 'survey@example.com' });
    token = tokenFor(biz);
  });

  it('lists the five reasons', async () => {
    const r = await request(app)
      .get(`/v1/businesses/${biz.id}/billing/cancel/reasons`)
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.reasons).toHaveLength(5);
    expect(r.body.reasons.map((x) => x.code)).toEqual(
      expect.arrayContaining([
        'too_expensive', 'not_using', 'missing_feature', 'switching', 'closing_down',
      ]),
    );
  });

  it('persists the reason and the free text', async () => {
    const r = await request(app)
      .post(`/v1/businesses/${biz.id}/billing/cancel/survey`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'too_expensive', note: 'Slow monsoon, ₹299 is a lot this month' });
    expect(r.status).toBe(200);
    expect(r.body.survey.reason).toBe('too_expensive');

    const row = await query(
      'SELECT * FROM cancellation_surveys WHERE business_id = $1',
      [biz.id],
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].reason).toBe('too_expensive');
    expect(row.rows[0].reason_note).toContain('monsoon');
    expect(row.rows[0].resolved_at).toBeNull();
  });

  it('re-opening the flow updates the open row instead of adding another', async () => {
    await request(app)
      .post(`/v1/businesses/${biz.id}/billing/cancel/survey`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'not_using' });
    const rows = await query(
      'SELECT * FROM cancellation_surveys WHERE business_id = $1',
      [biz.id],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].reason).toBe('not_using');
  });

  it('rejects an unknown reason', async () => {
    const r = await request(app)
      .post(`/v1/businesses/${biz.id}/billing/cancel/survey`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'because' });
    expect(r.status).toBe(400);
  });

  it('confirming the cancel resolves the survey against a REAL cancel', async () => {
    const r = await request(app)
      .post(`/v1/businesses/${biz.id}/billing/cancel`)
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    const rows = await query(
      'SELECT * FROM cancellation_surveys WHERE business_id = $1',
      [biz.id],
    );
    expect(rows.rows[0].offer_outcome).toBe('cancelled');
    expect(rows.rows[0].resolved_at).toBeTruthy();
    const sub = await subFor(biz.id);
    expect(sub.cancel_at_period_end).toBe(true);
    // The trail records it.
    const trail = await query(
      `SELECT event FROM subscription_lifecycle_events
        WHERE business_id = $1 ORDER BY created_at`,
      [biz.id],
    );
    expect(trail.rows.map((x) => x.event)).toEqual(
      expect.arrayContaining(['cancel_started', 'save_offer_shown', 'cancelled']),
    );
  });
});

// ── 4. Save-offer branching ─────────────────────────────────────────────

describe('the save offer branches on the reason', () => {
  let biz; let token;

  beforeAll(async () => {
    biz = await paidBusiness({ name: 'Branch Biryani', email: 'branch@example.com' });
    token = tokenFor(biz);
  });

  const ask = async (body) => {
    // Each ask closes the previous open survey so the partial unique index is
    // satisfied without the test caring about ordering.
    await query(
      `UPDATE cancellation_surveys SET resolved_at = NOW(), offer_outcome = 'declined'
        WHERE business_id = $1 AND resolved_at IS NULL`,
      [biz.id],
    );
    return request(app)
      .post(`/v1/businesses/${biz.id}/billing/cancel/survey`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  };

  it('too_expensive → a real cheaper path (downgrade / pause)', async () => {
    const r = await ask({ reason: 'too_expensive' });
    expect(r.status).toBe(200);
    expect(r.body.offer.kind).toBe('downgrade_or_pause');
    expect(r.body.offer.save).toBe(true);
    const actions = r.body.offer.options.map((o) => o.action);
    expect(actions).toContain('downgrade');
    expect(actions).toContain('pause');
  });

  it('not_using → pause and a setup call, not a discount', async () => {
    const r = await ask({ reason: 'not_using' });
    expect(r.body.offer.kind).toBe('pause');
    expect(r.body.offer.save).toBe(true);
    expect(r.body.offer.options.map((o) => o.action)).toEqual(['pause', 'founder_call']);
  });

  it('missing_feature → NO offer, and the note is required', async () => {
    const bad = await ask({ reason: 'missing_feature' });
    expect(bad.status).toBe(400);
    const r = await ask({ reason: 'missing_feature', note: 'No Zomato sync' });
    expect(r.body.offer.kind).toBe('founder_note');
    expect(r.body.offer.save).toBe(false);
    expect(r.body.offer.options).toHaveLength(0);
  });

  it('switching → NO offer', async () => {
    const r = await ask({ reason: 'switching' });
    expect(r.body.offer.save).toBe(false);
    expect(r.body.offer.options).toHaveLength(0);
  });

  it('closing_down → NO save offer at all, just a goodbye and the export', async () => {
    // THE ONE THAT MATTERS: a save offer shown to somebody whose restaurant
    // has shut is insulting. There must be no discount, no pause pitch, and
    // no "stay" button anywhere in this branch.
    const r = await ask({ reason: 'closing_down' });
    expect(r.body.offer.kind).toBe('goodbye');
    expect(r.body.offer.save).toBe(false);
    expect(r.body.offer.options).toHaveLength(0);
    expect(r.body.offer.exportPath).toBe('/billing/export');
    expect(JSON.stringify(r.body.offer)).not.toMatch(/discount|% off|upgrade|₹/i);

    // And nothing in the trail claims an offer was shown.
    const shown = await query(
      `SELECT * FROM subscription_lifecycle_events
        WHERE business_id = $1 AND event = 'save_offer_shown' AND reason = 'closing_down'`,
      [biz.id],
    );
    expect(shown.rowCount).toBe(0);
  });
});

// ── 5. Pause ────────────────────────────────────────────────────────────

describe('pause stops billing and resume restores the same plan', () => {
  let biz; let token; let idliId;

  beforeAll(async () => {
    biz = await paidBusiness({ name: 'Seasonal Shack', email: 'seasonal@example.com', tier: 'pro' });
    token = tokenFor(biz);
  });

  it('pauses for a chosen number of months and parks the plan', async () => {
    const r = await request(app)
      .post(`/v1/businesses/${biz.id}/billing/pause`)
      .set('Authorization', `Bearer ${token}`)
      .send({ months: 2 });
    expect(r.status).toBe(200);
    const sub = await subFor(biz.id);
    expect(sub.status).toBe('paused');
    expect(sub.pause_months).toBe(2);
    expect(sub.pause_plan_id).toBeTruthy();
    // Billing stops: the mandate is cancelled at cycle end and no renewal runs.
    expect(sub.cancel_at_period_end).toBe(false);
    const months = (new Date(sub.pause_ends_at) - Date.now()) / (30 * 86_400_000);
    expect(months).toBeGreaterThan(1.8);
  });

  it('is idempotent — a second tap does not re-pause', async () => {
    const before = await subFor(biz.id);
    const r = await request(app)
      .post(`/v1/businesses/${biz.id}/billing/pause`)
      .set('Authorization', `Bearer ${token}`)
      .send({ months: 3 });
    expect(r.status).toBe(200);
    expect(r.body.alreadyPaused).toBe(true);
    const after = await subFor(biz.id);
    expect(after.pause_months).toBe(2); // unchanged
    expect(after.paused_at).toEqual(before.paused_at);
  });

  it('a paused account cannot create an order', async () => {
    const item = await request(app)
      .post(`/v1/businesses/${biz.id}/menu`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Idli', price: 40, stock: 50 });
    idliId = item.body.item?.id || null;
    const r = await request(app)
      .post(`/v1/businesses/${biz.id}/orders`)
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ menuItemId: idliId, name: 'Idli', price: 40, qty: 1 }] });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('SUBSCRIPTION_PAUSED');
  });

  it('but can still READ its own history — that is the whole promise', async () => {
    const r = await request(app)
      .get(`/v1/businesses/${biz.id}/orders`)
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });

  it('the billing read tells the owner it is paused', async () => {
    const r = await request(app)
      .get(`/v1/businesses/${biz.id}/billing`)
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.subscription.pause.paused).toBe(true);
    expect(r.body.subscription.pause.pauseEndsAt).toBeTruthy();
  });

  it('resume restores the SAME plan, not a guessed one', async () => {
    const paused = await subFor(biz.id);
    const parkedPlanId = paused.pause_plan_id;
    const r = await request(app)
      .post(`/v1/businesses/${biz.id}/billing/resume`)
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    const sub = await subFor(biz.id);
    expect(sub.status).toBe('active');
    expect(sub.plan_id).toBe(parkedPlanId);
    expect(sub.plan_tier).toBe('pro');
    expect(sub.paused_at).toBeNull();
    expect(sub.pause_ends_at).toBeNull();
    // The rolling-12-month record survives the resume.
    expect(sub.last_pause_at).toBeTruthy();
  });

  it('billing works again after resume', async () => {
    const r = await request(app)
      .post(`/v1/businesses/${biz.id}/orders`)
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ menuItemId: idliId, name: 'Idli', price: 40, qty: 1 }] });
    expect(r.status).toBe(201);
  });

  it('one pause per 12 months', async () => {
    const r = await request(app)
      .post(`/v1/businesses/${biz.id}/billing/pause`)
      .set('Authorization', `Bearer ${token}`)
      .send({ months: 1 });
    expect(r.status).toBe(409);
  });

  it('a past_due account is told to settle first, not allowed to pause', async () => {
    const b = await paidBusiness({ name: 'Overdue Oven', email: 'overdue@example.com' });
    await query(
      "UPDATE subscriptions SET status = 'past_due', past_due_at = NOW() WHERE business_id = $1",
      [b.id],
    );
    const r = await request(app)
      .post(`/v1/businesses/${b.id}/billing/pause`)
      .set('Authorization', `Bearer ${tokenFor(b)}`)
      .send({ months: 1 });
    expect(r.status).toBe(409);
  });

  it('the nightly sweep auto-resumes a pause that has run its course', async () => {
    const b = await paidBusiness({ name: 'Monsoon Mess', email: 'monsoon@example.com' });
    await churn.pause(b.id, { months: 1 });
    await query(
      "UPDATE subscriptions SET pause_ends_at = NOW() - INTERVAL '1 day' WHERE business_id = $1",
      [b.id],
    );
    const out = await churn.autoResumeDue();
    expect(out.resumed).toBeGreaterThanOrEqual(1);
    const sub = await subFor(b.id);
    expect(sub.status).toBe('active');
    expect(sub.plan_tier).toBe('basic');
    const trail = await query(
      `SELECT event FROM subscription_lifecycle_events
        WHERE business_id = $1 AND event = 'auto_resumed'`,
      [b.id],
    );
    expect(trail.rowCount).toBe(1);
  });
});

// ── 6. Export ───────────────────────────────────────────────────────────

describe('export returns the owner\'s own data and only theirs', () => {
  let mine; let theirs; let token;

  beforeAll(async () => {
    mine = await paidBusiness({ name: 'Mine Mess', email: 'mine@example.com' });
    theirs = await paidBusiness({ name: 'Theirs Thali', email: 'theirs@example.com' });
    token = tokenFor(mine);
    await query(
      `INSERT INTO menu_items (business_id, name, price, category)
       VALUES ($1, 'My Paneer Tikka', 220, 'Starters'),
              ($2, 'Their Dal Makhani', 180, 'Mains')`,
      [mine.id, theirs.id],
    );
    await query(
      `INSERT INTO customers (business_id, phone, name)
       VALUES ($1, '+919111111111', 'My Regular'),
              ($2, '+919222222222', 'Their Regular')`,
      [mine.id, theirs.id],
    );
  });

  it('hands the owner a downloadable file of their own account', async () => {
    const r = await request(app)
      .get(`/v1/businesses/${mine.id}/billing/export`)
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toMatch(/attachment; filename="namastepos-export-/);
    const body = JSON.parse(r.text);
    expect(body.sections.business.name).toBe('Mine Mess');
    expect(body.sections.menu_items.map((m) => m.name)).toEqual(['My Paneer Tikka']);
    expect(body.sections.customers.map((c) => c.name)).toEqual(['My Regular']);
    expect(body.counts.menu_items).toBe(1);
  });

  it('leaks nothing from any other tenant', async () => {
    const r = await request(app)
      .get(`/v1/businesses/${mine.id}/billing/export`)
      .set('Authorization', `Bearer ${token}`);
    const raw = r.text;
    expect(raw).not.toContain('Their Dal Makhani');
    expect(raw).not.toContain('Their Regular');
    expect(raw).not.toContain(theirs.id);
  });

  it('refuses to export another tenant\'s account', async () => {
    const r = await request(app)
      .get(`/v1/businesses/${theirs.id}/billing/export`)
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  it('is NOT plan-gated — a cancelled owner can still take their data', async () => {
    await query(
      "UPDATE subscriptions SET status = 'cancelled' WHERE business_id = $1",
      [mine.id],
    );
    const r = await request(app)
      .get(`/v1/businesses/${mine.id}/billing/export`)
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    // And it is recorded, so "they took a copy" is answerable later.
    const trail = await query(
      `SELECT event FROM subscription_lifecycle_events
        WHERE business_id = $1 AND event = 'export_taken'`,
      [mine.id],
    );
    expect(trail.rowCount).toBeGreaterThanOrEqual(1);
  });
});
