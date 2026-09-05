// Recurring invoices (2026-09-06, round-2 review / CONTRACTS §2).
//
// A schedule bills ONE customer for a fixed line-item template every period
// (weekly | monthly | quarterly | yearly) — canteen contracts, catering
// retainers, tiffin subscriptions. Each run issues a real GST tax invoice via
// taxInvoiceService.issueFromRecurring (FY-sequential number, per-line GST,
// HSN summary), so the output is a statutory document, not a reminder.
//
// Before this file the feature was a table (migration 027) plus a cron that
// logged "fired" and bumped next_run_at; it was sold on Advanced/Enterprise.
//
// Idempotency: `recurring_invoice_runs` has UNIQUE (schedule_id, period_key)
// where period_key = the schedule's next_run_at (IST date) when the period is
// claimed. The claim is an INSERT … ON CONFLICT DO NOTHING inside the same
// transaction as the invoice, under FOR UPDATE on the schedule row, so two
// cron leaders / a retried tick / run-now racing the cron can only ever
// produce ONE invoice per period. The advance of next_run_at is in that same
// transaction — a crash between "invoice written" and "schedule advanced"
// rolls both back.
//
// Money on the wire is `*Paise` integers; template_payload stores
// { items: [{ name, hsn, qty, unitPricePaise, gstPct }], notes,
//   recipientGstin, recipientAddress }.
// `customers` carries no GSTIN/address columns (checked \d customers), so the
// B2B recipient's GSTIN + billing address live on the schedule.

const { query, withTransaction } = require('../config/db');
const { NotFound, BadRequest, HttpError } = require('../utils/errors');
const taxInvoices = require('./taxInvoiceService');
const logger = require('../config/logger');

const FREQUENCIES = Object.freeze(['weekly', 'monthly', 'quarterly', 'yearly']);
const FREQ_INTERVAL = Object.freeze({
  weekly: '7 days',
  monthly: '1 month',
  quarterly: '3 months',
  yearly: '1 year',
});

const SELECT_SCHEDULE = `
  SELECT ri.*, c.name AS customer_name, c.phone AS customer_phone,
         to_char((ri.end_at AT TIME ZONE 'Asia/Kolkata')::date - 1, 'YYYY-MM-DD') AS end_date
    FROM recurring_invoices ri
    JOIN customers c ON c.id = ri.customer_id AND c.business_id = ri.business_id`;

// ── Money helpers ────────────────────────────────────────────────────────

/** Line total incl. GST, integer paise. Same rounding as issueFromRecurring. */
function _lineTotalPaise(it) {
  const linePaise = Math.round(Number(it.qty) * Math.round(Number(it.unitPricePaise)));
  const gstPaise = Math.round((linePaise * (Number(it.gstPct) || 0)) / 100);
  return linePaise + gstPaise;
}

function _totalPaise(items) {
  return (items || []).reduce((s, it) => s + _lineTotalPaise(it), 0);
}

function _normaliseItems(items) {
  return items.map((it) => ({
    name: String(it.name).trim(),
    hsn: it.hsn ? String(it.hsn).trim() : null,
    qty: Number(it.qty),
    unitPricePaise: Math.round(Number(it.unitPricePaise)),
    gstPct: Number(it.gstPct) || 0,
  }));
}

function _serialize(row) {
  const payload = row.template_payload || {};
  const items = Array.isArray(payload.items) ? payload.items : [];
  return {
    id: row.id,
    name: row.name || '',
    customerId: row.customer_id,
    customerName: row.customer_name || null,
    customerPhone: row.customer_phone || null,
    frequency: row.frequency,
    nextRunAt: row.next_run_at,
    endDate: row.end_date || null,
    isActive: row.is_active,
    items,
    notes: payload.notes || null,
    recipientGstin: payload.recipientGstin || null,
    recipientAddress: payload.recipientAddress || null,
    totalPaise: _totalPaise(items),
    lastRunAt: row.last_run_at || null,
    lastInvoiceId: row.last_invoice_id || null,
    runCount: Number(row.run_count) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at || null,
  };
}

async function _assertCustomer(client, businessId, customerId) {
  const r = await client.query(
    'SELECT id FROM customers WHERE business_id = $1 AND id = $2',
    [businessId, customerId],
  );
  if (r.rowCount === 0) throw new NotFound('Customer not found');
}

// ── CRUD ─────────────────────────────────────────────────────────────────

async function list(businessId) {
  const r = await query(
    `${SELECT_SCHEDULE} WHERE ri.business_id = $1 ORDER BY ri.created_at DESC`,
    [businessId],
  );
  return r.rows.map(_serialize);
}

async function getById(businessId, id) {
  const r = await query(
    `${SELECT_SCHEDULE} WHERE ri.business_id = $1 AND ri.id = $2`,
    [businessId, id],
  );
  if (r.rowCount === 0) throw new NotFound('Recurring invoice not found');
  return _serialize(r.rows[0]);
}

async function create(businessId, body) {
  return withTransaction(async (client) => {
    await _assertCustomer(client, businessId, body.customerId);
    if (!FREQUENCIES.includes(body.frequency)) throw new BadRequest('Invalid frequency');
    const payload = {
      items: _normaliseItems(body.items),
      notes: body.notes || null,
      recipientGstin: body.recipientGstin ? String(body.recipientGstin).trim().toUpperCase() : null,
      recipientAddress: body.recipientAddress || null,
    };
    // Dates are IST business days: next_run_at = midnight IST on startDate;
    // end_at = midnight IST the day AFTER endDate so the end day is inclusive.
    const r = await client.query(
      `INSERT INTO recurring_invoices
         (business_id, customer_id, name, template_payload, frequency, next_run_at, end_at, is_active)
       VALUES ($1, $2, $3, $4::jsonb, $5,
               ($6::date)::timestamp AT TIME ZONE 'Asia/Kolkata',
               CASE WHEN $7::date IS NULL THEN NULL
                    ELSE (($7::date + 1))::timestamp AT TIME ZONE 'Asia/Kolkata' END,
               TRUE)
       RETURNING id`,
      [businessId, body.customerId, body.name || null, JSON.stringify(payload),
        body.frequency, body.startDate, body.endDate || null],
    );
    const row = await client.query(
      `${SELECT_SCHEDULE} WHERE ri.business_id = $1 AND ri.id = $2`,
      [businessId, r.rows[0].id],
    );
    return _serialize(row.rows[0]);
  });
}

async function update(businessId, id, patch) {
  return withTransaction(async (client) => {
    const cur = await client.query(
      'SELECT * FROM recurring_invoices WHERE business_id = $1 AND id = $2 FOR UPDATE',
      [businessId, id],
    );
    if (cur.rowCount === 0) throw new NotFound('Recurring invoice not found');
    const row = cur.rows[0];
    const payload = { ...(row.template_payload || {}) };
    if (patch.items !== undefined) payload.items = _normaliseItems(patch.items);
    if (patch.notes !== undefined) payload.notes = patch.notes || null;
    if (patch.recipientGstin !== undefined) {
      payload.recipientGstin = patch.recipientGstin
        ? String(patch.recipientGstin).trim().toUpperCase() : null;
    }
    if (patch.recipientAddress !== undefined) payload.recipientAddress = patch.recipientAddress || null;
    if (patch.customerId !== undefined) await _assertCustomer(client, businessId, patch.customerId);
    if (patch.frequency !== undefined && !FREQUENCIES.includes(patch.frequency)) {
      throw new BadRequest('Invalid frequency');
    }

    const sets = ['template_payload = $3::jsonb'];
    const vals = [businessId, id, JSON.stringify(payload)];
    const push = (sql, v) => { vals.push(v); sets.push(sql.replace('?', `$${vals.length}`)); };
    if (patch.name !== undefined) push('name = ?', patch.name || null);
    if (patch.customerId !== undefined) push('customer_id = ?', patch.customerId);
    if (patch.frequency !== undefined) push('frequency = ?', patch.frequency);
    if (patch.isActive !== undefined) push('is_active = ?', !!patch.isActive);
    if (patch.startDate !== undefined) {
      push("next_run_at = (?::date)::timestamp AT TIME ZONE 'Asia/Kolkata'", patch.startDate);
    }
    if (patch.endDate !== undefined) {
      if (patch.endDate === null || patch.endDate === '') {
        sets.push('end_at = NULL');
      } else {
        push("end_at = ((?::date + 1))::timestamp AT TIME ZONE 'Asia/Kolkata'", patch.endDate);
      }
    }
    await client.query(
      `UPDATE recurring_invoices SET ${sets.join(', ')} WHERE business_id = $1 AND id = $2`,
      vals,
    );
    const out = await client.query(
      `${SELECT_SCHEDULE} WHERE ri.business_id = $1 AND ri.id = $2`,
      [businessId, id],
    );
    return _serialize(out.rows[0]);
  });
}

async function remove(businessId, id) {
  const r = await query(
    'DELETE FROM recurring_invoices WHERE business_id = $1 AND id = $2',
    [businessId, id],
  );
  if (r.rowCount === 0) throw new NotFound('Recurring invoice not found');
}

// ── Generation ───────────────────────────────────────────────────────────

/**
 * Claim + generate ONE period for a schedule. Must be called with `client`
 * inside a transaction that already holds FOR UPDATE on the schedule row.
 * Returns { schedule, invoice, generated } — `generated:false` means this
 * period had already been invoiced (the existing invoice is returned) and only
 * next_run_at was advanced.
 */
async function _runLocked(client, row, { triggeredBy, issuedByUserId = null }) {
  const payload = row.template_payload || {};
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (items.length === 0) throw new BadRequest('Recurring invoice has no items');
  const interval = FREQ_INTERVAL[row.frequency] || FREQ_INTERVAL.monthly;

  // Claim the period. period_key is the IST calendar day of the run being
  // billed (= next_run_at before the advance).
  const claim = await client.query(
    `INSERT INTO recurring_invoice_runs (business_id, schedule_id, period_key, triggered_by)
     VALUES ($1, $2, ($3::timestamptz AT TIME ZONE 'Asia/Kolkata')::date, $4)
     ON CONFLICT (schedule_id, period_key) DO NOTHING
     RETURNING id`,
    [row.business_id, row.id, row.next_run_at, triggeredBy],
  );

  let invoice = null;
  let generated = false;
  if (claim.rowCount === 0) {
    // Period already invoiced (a retried tick, or run-now racing the cron).
    // Do not mint a second statutory document; surface the one that exists.
    const ex = await client.query(
      `SELECT invoice_id FROM recurring_invoice_runs
        WHERE schedule_id = $1 AND period_key = ($2::timestamptz AT TIME ZONE 'Asia/Kolkata')::date`,
      [row.id, row.next_run_at],
    );
    const invId = ex.rows[0]?.invoice_id;
    if (invId) {
      // The earlier run is committed (that is why the claim conflicted), so
      // the pool read is safe from inside this transaction.
      invoice = await taxInvoices.getById(row.business_id, invId).catch(() => null);
    }
  } else {
    invoice = await taxInvoices.issueFromRecurring(client, row.business_id, {
      items,
      recipient: {
        name: row.customer_name,
        phone: row.customer_phone,
        gstin: payload.recipientGstin || null,
        address: payload.recipientAddress || null,
      },
      notes: payload.notes || null,
      issuedByUserId,
    });
    generated = true;
    await client.query(
      'UPDATE recurring_invoice_runs SET invoice_id = $2 WHERE id = $1',
      [claim.rows[0].id, invoice.id],
    );
  }

  await client.query(
    `UPDATE recurring_invoices
        SET next_run_at = next_run_at + ($2::text)::interval,
            last_run_at = CASE WHEN $3 THEN NOW() ELSE last_run_at END,
            last_invoice_id = CASE WHEN $3 THEN $4::uuid ELSE last_invoice_id END,
            run_count = run_count + CASE WHEN $3 THEN 1 ELSE 0 END
      WHERE id = $1`,
    [row.id, interval, generated, generated ? invoice.id : null],
  );
  const out = await client.query(`${SELECT_SCHEDULE} WHERE ri.id = $1`, [row.id]);
  return { schedule: _serialize(out.rows[0]), invoice, generated };
}

/**
 * Manual "bill the next period now" from the dashboard. Advances next_run_at.
 */
async function runNow(businessId, id, { userId = null } = {}) {
  return withTransaction(async (client) => {
    const r = await client.query(
      `${SELECT_SCHEDULE} WHERE ri.business_id = $1 AND ri.id = $2 FOR UPDATE OF ri`,
      [businessId, id],
    );
    if (r.rowCount === 0) throw new NotFound('Recurring invoice not found');
    const { schedule, invoice } = await _runLocked(client, r.rows[0], {
      triggeredBy: 'manual', issuedByUserId: userId,
    });
    if (!invoice) {
      throw new HttpError(409, 'This period was already invoiced', 'PERIOD_ALREADY_INVOICED');
    }
    return {
      schedule,
      invoice: { id: invoice.id, invoiceNo: invoice.invoiceNo, totalPaise: Math.round(invoice.totalInr * 100) },
    };
  });
}

/**
 * Cron entry: generate for every schedule that is active, due and not ended.
 * One transaction per schedule (a bad template on one tenant must not roll
 * back another tenant's invoice). FOR UPDATE SKIP LOCKED + the re-check of
 * the due predicate inside the lock make a concurrent second leader harmless
 * even without the tick-level advisory lock cronWorker already takes.
 *
 * Re-checks the `recurring_invoices` feature key per business: a tenant that
 * downgraded keeps its schedules but stops receiving generated invoices.
 */
async function runDue({ limit = 50, now = null } = {}) {
  const features = require('./featureService');
  const due = await query(
    `SELECT id, business_id FROM recurring_invoices
      WHERE is_active = TRUE
        AND next_run_at <= COALESCE($2::timestamptz, NOW())
        AND (end_at IS NULL OR end_at > COALESCE($2::timestamptz, NOW()))
      ORDER BY next_run_at ASC
      LIMIT $1`,
    [limit, now],
  );
  let generated = 0;
  let skipped = 0;
  for (const d of due.rows) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const entitled = await features.hasFeature(d.business_id, 'recurring_invoices');
      if (!entitled) { skipped += 1; continue; }
      // eslint-disable-next-line no-await-in-loop
      const res = await withTransaction(async (client) => {
        const r = await client.query(
          `${SELECT_SCHEDULE}
            WHERE ri.id = $1 AND ri.is_active = TRUE
              AND ri.next_run_at <= COALESCE($2::timestamptz, NOW())
              AND (ri.end_at IS NULL OR ri.end_at > COALESCE($2::timestamptz, NOW()))
            FOR UPDATE OF ri SKIP LOCKED`,
          [d.id, now],
        );
        if (r.rowCount === 0) return null; // someone else took it, or no longer due
        return _runLocked(client, r.rows[0], { triggeredBy: 'cron' });
      });
      if (res && res.generated) generated += 1;
    } catch (e) {
      logger.warn(`[recurring-invoices] schedule ${d.id} (business ${d.business_id}) failed: ${e.message}`);
    }
  }
  return { due: due.rowCount, generated, skipped };
}

module.exports = {
  FREQUENCIES,
  list,
  getById,
  create,
  update,
  remove,
  runNow,
  runDue,
  _totalPaise,
};
