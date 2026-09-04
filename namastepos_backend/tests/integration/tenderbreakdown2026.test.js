// Regression for the accurate daily "collected by tender" breakdown (2026-09-01).
// Founder concern: a ₹150 order paid points ₹45 + wallet ₹50 + cash ₹55 was hard
// to reconcile — revenue (net sales) is ₹105, but only ₹55 cash hit the till and
// the wallet ₹50 is a prepaid draw-down, not new cash. The daily report now
// exposes an accurate per-tender split (from payment legs + single-tender orders)
// plus wallet/points transparency. This locks that math down.

const { resetDb, makeBusiness, closePool } = require('../setup');
const { query } = require('../../src/config/db');
const reportService = require('../../src/services/reportService');

let biz;
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

beforeAll(async () => {
  await resetDb();
  biz = await makeBusiness({ email: `tender-${Date.now()}@example.com` });

  // a) single-tender cash ₹100 (no payments row — falls back to payment_method)
  await query(`INSERT INTO orders (business_id, order_no, source, status, subtotal, total, payment_method, created_at)
     VALUES ($1, 1, 'takeaway', 'collected', 100, 100, 'cash', NOW())`, [biz.id]);
  // b) single-tender upi ₹60
  await query(`INSERT INTO orders (business_id, order_no, source, status, subtotal, total, payment_method, created_at)
     VALUES ($1, 2, 'takeaway', 'collected', 60, 60, 'upi', NOW())`, [biz.id]);
  // c) split ₹105 (₹150 gross − ₹45 points), legs wallet ₹50 + cash ₹55
  const c = await query(`INSERT INTO orders (business_id, order_no, source, status, subtotal, total,
                         payment_method, is_split_tender, points_redeemed, loyalty_discount_paise, created_at)
     VALUES ($1, 3, 'takeaway', 'collected', 150, 105, 'cash', true, 45, 4500, NOW()) RETURNING id`, [biz.id]);
  const cid = c.rows[0].id;
  await query(`INSERT INTO payments (business_id, order_id, method, amount_paise, status)
               VALUES ($1, $2, 'wallet', 5000, 'captured')`, [biz.id, cid]);
  await query(`INSERT INTO payments (business_id, order_id, method, amount_paise, status)
               VALUES ($1, $2, 'cash', 5500, 'captured')`, [biz.id, cid]);
});
afterAll(async () => { await closePool(); });

test('revenue is net sales (points excluded); tenders split cash/upi/wallet accurately', async () => {
  const r = await reportService.dailyReport(biz.id, today);

  // Revenue = SUM(orders.total) = 100 + 60 + 105 (points already out of total)
  expect(r.revenue.total).toBeCloseTo(265, 2);

  // Accurate per-tender: cash = 100 (single) + 55 (leg); upi = 60; wallet = 50
  expect(r.tenders.cash).toBeCloseTo(155, 2);
  expect(r.tenders.upi).toBeCloseTo(60, 2);
  expect(r.tenders.wallet).toBeCloseTo(50, 2);
  expect(r.tendersTotal).toBeCloseTo(265, 2);

  // Wallet is a prepaid draw-down, not new cash — cash collected today excludes it
  expect(r.walletCollected).toBeCloseTo(50, 2);
  expect(r.cashCollectedToday).toBeCloseTo(215, 2); // 265 − 50

  // Points shown as a business-funded discount, never counted as collected
  expect(r.discountBreakdown.pointsValue).toBeCloseTo(45, 2);
  expect(r.discountBreakdown.pointsRedeemed).toBe(45);
});
