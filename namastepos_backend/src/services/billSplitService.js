// Bill split — equal / by item / custom amounts (FF-304)

const { query, withTransaction } = require('../config/db');
const { BadRequest, NotFound } = require('../utils/errors');

async function splitSession(businessId, sessionId, body) {
  const { mode, splits } = body; // splits: [{ guestLabel, items?, amount?, customerPhone? }, ...]
  if (!['equal', 'by_item', 'custom'].includes(mode)) {
    throw new BadRequest('Invalid mode');
  }
  return withTransaction(async (client) => {
    // Get session total
    const s = await client.query(
      `SELECT id, total_paise, status FROM table_sessions
        WHERE business_id = $1 AND id = $2`,
      [businessId, sessionId],
    );
    if (s.rowCount === 0) throw new NotFound('Session not found');
    // Use live SUM for open sessions
    const liveTotal = await client.query(
      `SELECT COALESCE(SUM(total), 0)::float AS t FROM orders
        WHERE table_session_id = $1 AND status <> 'cancelled'`,
      [sessionId],
    );
    const totalPaise = Math.round(parseFloat(liveTotal.rows[0].t) * 100);

    const invoices = [];
    if (mode === 'equal') {
      const n = splits.length;
      if (n < 2) throw new BadRequest('Need at least 2 splits');
      const per = Math.floor(totalPaise / n);
      const remainder = totalPaise - (per * n);
      for (let i = 0; i < n; i += 1) {
        invoices.push({
          guestLabel: splits[i].guestLabel || `Guest ${i + 1}`,
          customerPhone: splits[i].customerPhone || null,
          amountPaise: per + (i === 0 ? remainder : 0),
        });
      }
    } else if (mode === 'custom') {
      let sum = 0;
      for (const sp of splits) {
        const amt = Math.round((sp.amount || 0) * 100);
        if (amt <= 0) throw new BadRequest('Each split amount must be positive');
        sum += amt;
        invoices.push({
          guestLabel: sp.guestLabel || 'Guest',
          customerPhone: sp.customerPhone || null,
          amountPaise: amt,
        });
      }
      if (sum !== totalPaise) {
        throw new BadRequest(`Splits sum (₹${sum / 100}) doesn't match bill (₹${totalPaise / 100})`);
      }
    } else if (mode === 'by_item') {
      // splits = [{ guestLabel, items: [{ orderItemId, qty }] }]
      // Re-price each guest's items at their actual line price
      const items = await client.query(
        `SELECT oi.id, oi.price, oi.qty FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
          WHERE o.table_session_id = $1 AND o.status <> 'cancelled'`,
        [sessionId],
      );
      const byId = new Map(items.rows.map((r) => [r.id, r]));
      // Every non-cancelled line must be fully allocated across guests —
      // otherwise omitted items silently under-collect the bill.
      const allItemsPaise = items.rows.reduce((s, r) => s + Math.round(parseFloat(r.price) * parseFloat(r.qty) * 100), 0);
      let splitSum = 0;
      for (const sp of splits) {
        let amt = 0;
        for (const it of sp.items || []) {
          const row = byId.get(it.orderItemId);
          if (!row) throw new BadRequest('Unknown orderItemId in split');
          const qty = Math.min(it.qty, parseFloat(row.qty));
          amt += Math.round(parseFloat(row.price) * qty * 100);
        }
        splitSum += amt;
        invoices.push({
          guestLabel: sp.guestLabel || 'Guest',
          customerPhone: sp.customerPhone || null,
          amountPaise: amt,
        });
      }
      if (splitSum !== allItemsPaise) {
        throw new BadRequest(
          `By-item split covers ₹${splitSum / 100} but the bill's items total ₹${allItemsPaise / 100} — every item must be assigned to a guest.`,
        );
      }
    }

    const split = await client.query(
      `INSERT INTO bill_splits
         (business_id, parent_session_id, split_mode, payload, total_paise)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [businessId, sessionId, mode, JSON.stringify({ splits, invoices }), totalPaise],
    );
    for (const inv of invoices) {
      await client.query(
        `INSERT INTO bill_split_invoices
           (bill_split_id, guest_label, customer_phone, amount_paise)
         VALUES ($1, $2, $3, $4)`,
        [split.rows[0].id, inv.guestLabel, inv.customerPhone, inv.amountPaise],
      );
    }
    return { ...split.rows[0], invoices };
  });
}

async function paySplit(businessId, splitInvoiceId, paymentMethod) {
  // P0 fix (2026-08-22): was WHERE id = $2 with no tenant scope — any
  // authenticated user could mark another tenant's split invoice paid
  // by guessing/enumerating UUIDs. Now joins through bill_splits to
  // verify business ownership; unauthorised writes return 0 rows.
  const r = await query(
    `UPDATE bill_split_invoices
        SET payment_method = $1::payment_method, paid_at = NOW()
      WHERE id = $2
        AND bill_split_id IN (
          SELECT id FROM bill_splits WHERE business_id = $3
        )
      RETURNING *`,
    [paymentMethod, splitInvoiceId, businessId],
  );
  if (r.rowCount === 0) {
    const { NotFound } = require('../utils/errors');
    throw new NotFound('Split invoice not found');
  }
  return r.rows[0];
}

async function listForSession(businessId, sessionId) {
  const splits = await query(
    `SELECT bs.*,
            (SELECT json_agg(bsi ORDER BY bsi.amount_paise DESC)
               FROM bill_split_invoices bsi WHERE bsi.bill_split_id = bs.id) AS invoices
       FROM bill_splits bs
      WHERE bs.business_id = $1 AND bs.parent_session_id = $2
      ORDER BY bs.created_at DESC`,
    [businessId, sessionId],
  );
  return splits.rows;
}

module.exports = { splitSession, paySplit, listForSession };
