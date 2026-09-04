// NamastePOS — Gift cards + prepaid wallet (FF-1005).
//
// Two related products, one ledger:
//   • Gift card: printable code sold to customer A, redeemable by
//     anyone holding the code. Balance stays on the card.
//   • Customer wallet: attached to a customers row, top-up via cash
//     or Razorpay. Redeemable only by that customer.
//
// Both share `wallet_ledger` for audit + DPDP export. Every credit or
// debit inserts a ledger row in the same transaction as the balance
// update, so the two can never drift.
//
// Redeem-at-POS flow (called from confirm-order):
//   1. cashier enters gift code OR selects customer wallet
//   2. we compute the redeemable = min(balance, orderTotal)
//   3. `redeem()` debits the source + inserts a `redeem` ledger row
//   4. POS records the remaining amount under whatever tender the
//      customer pays with (cash/UPI/…)

const crypto = require('crypto');
const { query, withTransaction } = require('../config/db');
const { BadRequest, NotFound } = require('../utils/errors');

function genCode() {
  // 16 alphanumeric chars, no confusable 0/O/1/I chars.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = crypto.randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) out += alphabet[buf[i] % alphabet.length];
  return out.match(/.{1,4}/g).join('-'); // AAAA-BBBB-CCCC-DDDD
}

// ── Gift cards ───────────────────────────────────────────────────────
async function issueGiftCard(businessId, {
  faceValueInr, issuedToPhone, expiresAt, issuedByUserId,
}) {
  if (!(faceValueInr > 0)) throw new BadRequest('faceValueInr must be > 0');
  const paise = Math.round(faceValueInr * 100);
  return withTransaction(async (c) => {
    const r = await c.query(
      `INSERT INTO gift_cards
         (business_id, code, face_value_paise, balance_paise,
          issued_to_phone, issued_by_user_id, expires_at)
       VALUES ($1, $2, $3, $3, $4, $5, $6)
       RETURNING *`,
      [businessId, genCode(), paise, issuedToPhone || null, issuedByUserId, expiresAt || null],
    );
    await c.query(
      `INSERT INTO wallet_ledger
         (business_id, gift_card_id, kind, amount_paise, note)
       VALUES ($1, $2, 'credit_issued', $3, $4)`,
      [businessId, r.rows[0].id, paise, `Gift card issued (${issuedToPhone || 'anonymous'})`],
    );
    return r.rows[0];
  });
}

async function findGiftCardByCode(businessId, code) {
  const r = await query(
    'SELECT * FROM gift_cards WHERE business_id = $1 AND code = $2 LIMIT 1',
    [businessId, code.trim().toUpperCase()],
  );
  return r.rows[0] || null;
}

// ── Customer wallets ────────────────────────────────────────────────
async function topUpWallet(businessId, customerId, amountInr, note) {
  const paise = Math.round(amountInr * 100);
  return withTransaction(async (c) => {
    await c.query(
      `INSERT INTO customer_wallets (business_id, customer_id, balance_paise)
       VALUES ($1, $2, $3)
       ON CONFLICT (business_id, customer_id) DO UPDATE
         SET balance_paise = customer_wallets.balance_paise + EXCLUDED.balance_paise,
             updated_at = NOW()`,
      [businessId, customerId, paise],
    );
    await c.query(
      `INSERT INTO wallet_ledger
         (business_id, customer_id, kind, amount_paise, note)
       VALUES ($1, $2, 'credit_top_up', $3, $4)`,
      [businessId, customerId, paise, note || 'Top-up'],
    );
    const r = await c.query(
      `SELECT balance_paise FROM customer_wallets
        WHERE business_id = $1 AND customer_id = $2`,
      [businessId, customerId],
    );
    return { balance: parseFloat(r.rows[0].balance_paise) / 100 };
  });
}

async function getWalletBalance(businessId, customerId) {
  const r = await query(
    `SELECT balance_paise FROM customer_wallets
      WHERE business_id = $1 AND customer_id = $2 LIMIT 1`,
    [businessId, customerId],
  );
  return parseFloat(r.rows[0]?.balance_paise || 0) / 100;
}

// ── Wallet-as-tender + shortfall (2026-08-25, founder) ──────────────
//
// These two helpers take a `client` (an open pg transaction) instead of
// owning their own withTransaction like redeem() above. WHY: wallet
// payment legs must commit/roll back ATOMICALLY with the order / session
// settle / membership sale that they pay for — a nested standalone txn
// (the redeem() pattern) would let the wallet debit survive an order
// rollback, i.e. take the customer's money for an order that never
// existed. Ledger `kind` vocabulary for these flows (fixed, agreed with
// the UI agents): 'order_payment' | 'shortfall' | 'membership_refund' |
// 'manual_adjust' | 'gift_card_load'.

/**
 * Debit a customer wallet inside an existing transaction.
 * - default: refuses to overdraw (atomic conditional UPDATE → 400 with
 *   the current balance when insufficient — same guard as redeem()).
 * - allowNegative: ONLY for reason 'shortfall' ("customer underpaid,
 *   owes us") — the balance may go below zero so the debt shows up as
 *   a negative wallet on the customer card.
 */
async function debitWalletTx(client, businessId, customerId, amountPaise, {
  reason, orderId = null, note = null, allowNegative = false,
} = {}) {
  const paise = Math.round(Number(amountPaise));
  if (!(paise > 0)) throw new BadRequest('Wallet debit must be > 0');
  if (!customerId) throw new BadRequest('Wallet debit requires a customer');
  let balanceAfter;
  if (allowNegative) {
    // Upsert so a customer with no wallet row yet can still go negative
    // (first-ever interaction being a shortfall is legal).
    const r = await client.query(
      `INSERT INTO customer_wallets (business_id, customer_id, balance_paise)
       VALUES ($1, $2, $3)
       ON CONFLICT (business_id, customer_id) DO UPDATE
         SET balance_paise = customer_wallets.balance_paise + EXCLUDED.balance_paise,
             updated_at = NOW()
       RETURNING balance_paise`,
      [businessId, customerId, -paise],
    );
    balanceAfter = Number(r.rows[0].balance_paise);
  } else {
    const upd = await client.query(
      `UPDATE customer_wallets SET balance_paise = balance_paise - $1,
                                   updated_at = NOW()
        WHERE business_id = $2 AND customer_id = $3
          AND balance_paise >= $1
        RETURNING balance_paise`,
      [paise, businessId, customerId],
    );
    if (upd.rowCount === 0) {
      const cur = await client.query(
        `SELECT balance_paise FROM customer_wallets
          WHERE business_id = $1 AND customer_id = $2 LIMIT 1`,
        [businessId, customerId],
      );
      const bal = parseFloat(cur.rows[0]?.balance_paise || 0) / 100;
      throw new BadRequest(
        `Insufficient wallet balance: ₹${bal.toFixed(2)} available, `
        + `₹${(paise / 100).toFixed(2)} needed`,
      );
    }
    balanceAfter = Number(upd.rows[0].balance_paise);
  }
  await client.query(
    `INSERT INTO wallet_ledger
       (business_id, customer_id, order_id, kind, amount_paise, note)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [businessId, customerId, orderId, reason || 'manual_adjust', -paise, note],
  );
  return { balanceAfterInr: balanceAfter / 100 };
}

/** Credit a customer wallet inside an existing transaction (refunds etc). */
async function creditWalletTx(client, businessId, customerId, amountPaise, {
  reason, orderId = null, note = null,
} = {}) {
  const paise = Math.round(Number(amountPaise));
  if (!(paise > 0)) throw new BadRequest('Wallet credit must be > 0');
  if (!customerId) throw new BadRequest('Wallet credit requires a customer');
  const r = await client.query(
    `INSERT INTO customer_wallets (business_id, customer_id, balance_paise)
     VALUES ($1, $2, $3)
     ON CONFLICT (business_id, customer_id) DO UPDATE
       SET balance_paise = customer_wallets.balance_paise + EXCLUDED.balance_paise,
           updated_at = NOW()
     RETURNING balance_paise`,
    [businessId, customerId, paise],
  );
  await client.query(
    `INSERT INTO wallet_ledger
       (business_id, customer_id, order_id, kind, amount_paise, note)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [businessId, customerId, orderId, reason || 'manual_adjust', paise, note],
  );
  return { balanceAfterInr: Number(r.rows[0].balance_paise) / 100 };
}

/**
 * Wallet read API for the dashboard customer card (2026-08-25):
 * balance + last 50 ledger movements, newest first.
 */
async function getWallet(businessId, customerId) {
  const balanceInr = await getWalletBalance(businessId, customerId);
  const r = await query(
    `SELECT id, order_id, kind, amount_paise, note, created_at
       FROM wallet_ledger
      WHERE business_id = $1 AND customer_id = $2
      ORDER BY created_at DESC LIMIT 50`,
    [businessId, customerId],
  );
  return {
    balanceInr,
    transactions: r.rows.map((t) => ({
      id: t.id,
      orderId: t.order_id,
      reason: t.kind,
      amountInr: Number(t.amount_paise) / 100, // positive = credit, negative = debit
      note: t.note,
      createdAt: t.created_at,
    })),
  };
}

// ── Redeem (either source) ──────────────────────────────────────────
async function redeem(businessId, {
  giftCardCode, customerId, orderId, amountInr,
}) {
  const paise = Math.round(amountInr * 100);
  if (paise <= 0) throw new BadRequest('Redeem amount must be > 0');

  // CRITICAL FIX (2026-08-23, review C3): the balance was checked BEFORE
  // the transaction and then decremented unconditionally — two concurrent
  // redeems could both pass the check and drive the balance negative
  // (free money). The decrement is now conditional (`balance >= amount`)
  // and atomic; 0 rows updated = insufficient balance.
  if (giftCardCode) {
    return withTransaction(async (c) => {
      // NP-124 (2026-09-03): normalize the code the same way findGiftCardByCode
      // does — codes are stored uppercase (genCode) but cashiers type lowercase,
      // so the raw `code = $2` match 404'd valid cards at redeem time.
      const gcQ = await c.query(
        `SELECT * FROM gift_cards
          WHERE business_id = $1 AND code = $2
          LIMIT 1 FOR UPDATE`,
        [businessId, String(giftCardCode).trim().toUpperCase()],
      );
      if (gcQ.rowCount === 0) throw new NotFound('Gift card not found');
      const gc = gcQ.rows[0];
      if (gc.expires_at && new Date(gc.expires_at) < new Date()) {
        throw new BadRequest('Gift card expired');
      }
      const upd = await c.query(
        `UPDATE gift_cards SET balance_paise = balance_paise - $1
          WHERE id = $2 AND balance_paise >= $1
          RETURNING balance_paise`,
        [paise, gc.id],
      );
      if (upd.rowCount === 0) {
        throw new BadRequest(`Only ₹${(gc.balance_paise / 100).toFixed(2)} available on this card`);
      }
      await c.query(
        `INSERT INTO wallet_ledger
           (business_id, gift_card_id, order_id, kind, amount_paise, note)
         VALUES ($1, $2, $3, 'redeem', $4, $5)`,
        [businessId, gc.id, orderId || null, -paise, 'Gift card redemption'],
      );
      return {
        source: 'gift_card',
        code: gc.code,
        remaining: upd.rows[0].balance_paise / 100,
      };
    });
  }
  if (customerId) {
    return withTransaction(async (c) => {
      const upd = await c.query(
        `UPDATE customer_wallets SET balance_paise = balance_paise - $1,
                                     updated_at = NOW()
          WHERE business_id = $2 AND customer_id = $3
            AND balance_paise >= $1
          RETURNING balance_paise`,
        [paise, businessId, customerId],
      );
      if (upd.rowCount === 0) {
        const cur = await getWalletBalance(businessId, customerId);
        throw new BadRequest(`Only ₹${cur.toFixed(2)} in wallet`);
      }
      await c.query(
        `INSERT INTO wallet_ledger
           (business_id, customer_id, order_id, kind, amount_paise, note)
         VALUES ($1, $2, $3, 'redeem', $4, $5)`,
        [businessId, customerId, orderId || null, -paise, 'Wallet redemption'],
      );
      return { source: 'wallet', remaining: upd.rows[0].balance_paise / 100 };
    });
  }
  throw new BadRequest('Provide giftCardCode or customerId');
}

/**
 * In-transaction redeem (2026-08-25, security review finding #6).
 *
 * Same semantics + ledger rows as redeem() above, but runs on the
 * CALLER's open pg client instead of owning its own withTransaction.
 * WHY: orderService used to defer the walletRedeem debit to a
 * post-commit .then() — a failed debit (insufficient balance, expired
 * card) left a fully committed order that was never paid for (free
 * food). Running the debit inside the order txn means a failed debit
 * rolls the whole order back, mirroring the paymentBreakdown 'wallet'
 * leg path (debitWalletTx). Appended (not edited) per append-only rule.
 */
async function redeemTx(client, businessId, {
  giftCardCode, customerId, orderId, amountInr,
}) {
  const paise = Math.round(amountInr * 100);
  if (paise <= 0) throw new BadRequest('Redeem amount must be > 0');

  if (giftCardCode) {
    // NP-124 (2026-09-03): same normalization as findGiftCardByCode / redeem()
    // — stored codes are uppercase, cashier input may not be.
    const gcQ = await client.query(
      `SELECT * FROM gift_cards
        WHERE business_id = $1 AND code = $2
        LIMIT 1 FOR UPDATE`,
      [businessId, String(giftCardCode).trim().toUpperCase()],
    );
    if (gcQ.rowCount === 0) throw new NotFound('Gift card not found');
    const gc = gcQ.rows[0];
    if (gc.expires_at && new Date(gc.expires_at) < new Date()) {
      throw new BadRequest('Gift card expired');
    }
    const upd = await client.query(
      `UPDATE gift_cards SET balance_paise = balance_paise - $1
        WHERE id = $2 AND balance_paise >= $1
        RETURNING balance_paise`,
      [paise, gc.id],
    );
    if (upd.rowCount === 0) {
      throw new BadRequest(`Only ₹${(gc.balance_paise / 100).toFixed(2)} available on this card`);
    }
    await client.query(
      `INSERT INTO wallet_ledger
         (business_id, gift_card_id, order_id, kind, amount_paise, note)
       VALUES ($1, $2, $3, 'redeem', $4, $5)`,
      [businessId, gc.id, orderId || null, -paise, 'Gift card redemption'],
    );
    return {
      source: 'gift_card',
      code: gc.code,
      remaining: upd.rows[0].balance_paise / 100,
    };
  }
  if (customerId) {
    const upd = await client.query(
      `UPDATE customer_wallets SET balance_paise = balance_paise - $1,
                                   updated_at = NOW()
        WHERE business_id = $2 AND customer_id = $3
          AND balance_paise >= $1
        RETURNING balance_paise`,
      [paise, businessId, customerId],
    );
    if (upd.rowCount === 0) {
      const cur = await client.query(
        `SELECT balance_paise FROM customer_wallets
          WHERE business_id = $1 AND customer_id = $2 LIMIT 1`,
        [businessId, customerId],
      );
      const bal = parseFloat(cur.rows[0]?.balance_paise || 0) / 100;
      throw new BadRequest(`Only ₹${bal.toFixed(2)} in wallet`);
    }
    await client.query(
      `INSERT INTO wallet_ledger
         (business_id, customer_id, order_id, kind, amount_paise, note)
       VALUES ($1, $2, $3, 'redeem', $4, $5)`,
      [businessId, customerId, orderId || null, -paise, 'Wallet redemption'],
    );
    return { source: 'wallet', remaining: upd.rows[0].balance_paise / 100 };
  }
  throw new BadRequest('Provide giftCardCode or customerId');
}

// ── Listing (dashboard / admin) ─────────────────────────────────────
async function listGiftCards(businessId, { active = true } = {}) {
  const r = await query(
    `SELECT id, code, face_value_paise, balance_paise, issued_to_phone,
            issued_at, expires_at
       FROM gift_cards
      WHERE business_id = $1
        AND ($2::boolean IS NULL OR ($2 = TRUE AND balance_paise > 0)
                                 OR ($2 = FALSE AND balance_paise = 0))
      ORDER BY issued_at DESC LIMIT 200`,
    [businessId, active],
  );
  return r.rows.map((r) => ({
    id: r.id,
    code: r.code,
    faceValue: parseFloat(r.face_value_paise) / 100,
    balance: parseFloat(r.balance_paise) / 100,
    issuedToPhone: r.issued_to_phone,
    issuedAt: r.issued_at,
    expiresAt: r.expires_at,
  }));
}

module.exports = {
  issueGiftCard,
  findGiftCardByCode,
  topUpWallet,
  getWalletBalance,
  getWallet,
  debitWalletTx,
  creditWalletTx,
  redeem,
  redeemTx,
  listGiftCards,
};
