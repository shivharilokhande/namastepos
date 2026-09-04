// Printer driver + KDS + ESC/POS render (Sprint 5 / FF-801, FF-802, FF-603)

const { query } = require('../config/db');
const { NotFound } = require('../utils/errors');

// ── Printer CRUD ─────────────────────────────────────────────────────────
async function listPrinters(businessId) {
  const r = await query(
    `SELECT p.*, ks.name AS station_name
       FROM printers p
  LEFT JOIN kot_stations ks ON ks.id = p.station_id
      WHERE p.business_id = $1 AND p.is_active = TRUE
      ORDER BY p.kind, p.name`,
    [businessId],
  );
  return r.rows;
}

async function upsertPrinter(businessId, body) {
  const { id, name, kind, connection, address, paperWidthMm, stationId, isDefault } = body;
  if (id) {
    const r = await query(
      `UPDATE printers SET name = $1, kind = $2, connection = $3,
             address = $4, paper_width_mm = $5, station_id = $6, is_default = $7
        WHERE id = $8 AND business_id = $9 RETURNING *`,
      [name, kind, connection, address, paperWidthMm || 80, stationId || null,
        isDefault === true, id, businessId],
    );
    if (r.rowCount === 0) throw new NotFound('Printer not found');
    return r.rows[0];
  }
  const r = await query(
    `INSERT INTO printers
       (business_id, name, kind, connection, address, paper_width_mm,
        station_id, is_default)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [businessId, name, kind, connection, address || null,
      paperWidthMm || 80, stationId || null, isDefault === true],
  );
  return r.rows[0];
}

async function deletePrinter(businessId, id) {
  await query(
    `UPDATE printers SET is_active = FALSE
      WHERE business_id = $1 AND id = $2`,
    [businessId, id],
  );
}

// ── Print queue ──────────────────────────────────────────────────────────
// NP-301 (2026-09-04): a print job is a ROW, and rows belong in the caller's
// transaction. `queuePrintJob` therefore takes an optional `client`: order
// creation enqueues the kitchen's paper INSIDE the order txn (so an order can
// never commit without its print job), while ad-hoc reprints keep using the
// pool. The actual I/O stays where it always was — outside any transaction, in
// the print agent that polls `dequeueNext`.
async function queuePrintJob({
  businessId, printerId, orderId, kotTicketId, kind, payloadText, client,
}) {
  const exec = client ? client.query.bind(client) : query;
  const r = await exec(
    `INSERT INTO print_jobs
       (business_id, printer_id, order_id, kot_ticket_id, kind, payload_text)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [businessId, printerId || null, orderId || null, kotTicketId || null, kind, payloadText],
  );
  return r.rows[0].id;
}

// NP-301: how many times the agent may fail a job before it dead-letters.
// A tuning constant, not config (same reasoning as cronWorker's CRON_LOCK_KEY):
// a thermal printer that is offline for six polls needs a human, not a longer
// retry loop.
const PRINT_JOB_MAX_ATTEMPTS = 6;
// Backoff between attempts, in seconds, indexed by attempts-so-far. The agent
// polls every few seconds, so this spreads a jammed printer over ~5 minutes
// instead of hammering it.
const PRINT_JOB_BACKOFF_SEC = [5, 15, 30, 60, 120, 300];

async function dequeueNext(businessId) {
  // Print agent on the cashier's machine polls this; takes one job at a time.
  // NP-301: only jobs whose backoff has elapsed are claimable, so a retrying
  // job doesn't monopolise the head of the queue while it waits.
  const r = await query(
    `UPDATE print_jobs SET status = 'printing', attempts = attempts + 1
      WHERE id = (
        SELECT id FROM print_jobs
          WHERE business_id = $1 AND status = 'queued'
            AND next_attempt_at <= NOW()
          ORDER BY created_at LIMIT 1
          FOR UPDATE SKIP LOCKED
      )
      RETURNING *`,
    [businessId],
  );
  return r.rows[0] || null;
}

// NP-301: 'failed' used to be reached on the FIRST agent error, and
// `dequeueNext` only ever picks 'queued' — so one offline printer permanently
// lost that KOT. A failure now returns the job to 'queued' with a backoff
// (queued → printing → queued → … the audit's PENDING → RETRYING → PRINTED)
// and only dead-letters to 'failed' once attempts are exhausted, at which
// point the nightly integrity email escalates it to a human.
async function markJobDone(businessId, jobId, ok, errorMessage) {
  if (ok) {
    await query(
      `UPDATE print_jobs
          SET status = 'done', error_message = NULL, completed_at = NOW()
        WHERE business_id = $1 AND id = $2`,
      [businessId, jobId],
    );
    return { status: 'done' };
  }
  const r = await query(
    `UPDATE print_jobs
        SET status = CASE WHEN attempts >= $1 THEN 'failed' ELSE 'queued' END,
            error_message = $2,
            -- Postgres arrays are 1-based, and attempts was already
            -- incremented by dequeueNext, so attempt #1 picks step 1.
            next_attempt_at = NOW() + make_interval(secs =>
              ($3::int[])[LEAST(GREATEST(attempts, 1), $4)])
      WHERE business_id = $5 AND id = $6
      RETURNING status, attempts`,
    [PRINT_JOB_MAX_ATTEMPTS, errorMessage || null,
      PRINT_JOB_BACKOFF_SEC, PRINT_JOB_BACKOFF_SEC.length, businessId, jobId],
  );
  return r.rows[0] || null;
}

/**
 * Requeue print jobs the agent claimed and then died on ('printing' with no
 * completion). Without this a crashed/killed agent silently swallows the
 * ticket it was holding. Called from the cron worker.
 */
async function requeueStalePrintJobs({ staleMinutes = 5, limit = 200 } = {}) {
  const r = await query(
    `UPDATE print_jobs
        SET status = CASE WHEN attempts >= $1 THEN 'failed' ELSE 'queued' END,
            error_message = COALESCE(error_message,
              'print agent claimed the job and never reported back'),
            next_attempt_at = NOW()
      WHERE id IN (
        SELECT id FROM print_jobs
          WHERE status = 'printing'
            AND created_at < NOW() - make_interval(mins => $2::int)
          ORDER BY created_at
          LIMIT $3
      )
      RETURNING id, status`,
    [PRINT_JOB_MAX_ATTEMPTS, staleMinutes, limit],
  );
  return { requeued: r.rows.filter((x) => x.status === 'queued').length,
    deadLettered: r.rows.filter((x) => x.status === 'failed').length };
}

// ── ESC/POS receipt rendering ────────────────────────────────────────────
function renderReceiptText({ template, order, items, isDuplicate = false }) {
  const w = template?.paperWidthMm === 58 ? 32 : 48; // chars per line
  const line = (l = '-') => l.repeat(w);
  const center = (s) => {
    const pad = Math.max(0, Math.floor((w - s.length) / 2));
    return ' '.repeat(pad) + s;
  };
  const pair = (l, r) => {
    const space = Math.max(1, w - l.length - r.length);
    return l + ' '.repeat(space) + r;
  };

  const out = [];
  if (isDuplicate) out.push(center('*** DUPLICATE ***'));
  for (const h of (template?.headerLines || [])) out.push(center(h));
  if (template?.gstin) out.push(center(`GSTIN: ${template.gstin}`));
  if (template?.fssaiNo) out.push(center(`FSSAI: ${template.fssaiNo}`));
  out.push(line('='));
  out.push(`Order #${order.orderNo}  ${order.source}`);
  out.push(new Date(order.createdAt).toLocaleString());
  if (order.tableNo) out.push(`Table: ${order.tableNo}`);
  if (order.customerPhone) out.push(`Phone: ${order.customerPhone}`);
  out.push(line('-'));
  for (const it of items) {
    out.push(pair(`${it.qty} × ${it.name}`.slice(0, w - 8), `${(it.price * it.qty).toFixed(2)}`));
    if (it.variantLabel) out.push(`   · ${it.variantLabel}`);
    if (Array.isArray(it.modifierLines)) {
      for (const m of it.modifierLines) out.push(`   + ${m.name}`);
    }
  }
  out.push(line('-'));
  out.push(pair('Subtotal', order.subtotal.toFixed(2)));
  if (order.serviceChargeInr > 0) out.push(pair('Service', `+ ${order.serviceChargeInr.toFixed(2)}`));
  if (template?.showTaxBreakdown && order.cgst > 0) {
    out.push(pair('CGST', `+ ${order.cgst.toFixed(2)}`));
    out.push(pair('SGST', `+ ${order.sgst.toFixed(2)}`));
  } else if (order.tax > 0) {
    out.push(pair('Tax', `+ ${order.tax.toFixed(2)}`));
  }
  if (order.discount > 0) out.push(pair('Discount', `- ${order.discount.toFixed(2)}`));
  if (order.roundOffInr) out.push(pair('Round off', (order.roundOffInr > 0 ? '+ ' : '- ') + Math.abs(order.roundOffInr).toFixed(2)));
  out.push(line('='));
  out.push(pair('TOTAL', order.total.toFixed(2)));
  out.push(`Payment: ${order.paymentMethod}`);
  if (template?.showToken && order.tokenNo) {
    out.push('');
    out.push(center(`TOKEN #${order.tokenNo}`));
  }
  if (template?.footerText) {
    out.push(line('-'));
    out.push(center(template.footerText));
  }
  return out.join('\n');
}

/**
 * NP-301 — ESC/POS text for a kitchen ticket. Deliberately dumb: station
 * name, ticket number, table/token, and the lines to cook. No money (the
 * kitchen must never be able to read the bill off a KOT), because a KOT is
 * a work order, not a receipt.
 */
function renderKotText({
  stationName, ticketNo, orderNo, source, tableLabel, tokenNo,
  items = [], paperWidthMm = 58, createdAt,
}) {
  const w = paperWidthMm === 80 ? 48 : 32;
  const line = (l = '-') => l.repeat(w);
  const center = (s) => ' '.repeat(Math.max(0, Math.floor((w - s.length) / 2))) + s;

  const out = [];
  out.push(center((stationName || 'KITCHEN').toUpperCase()));
  out.push(center(`KOT #${ticketNo}`));
  out.push(line('='));
  out.push(`Order #${orderNo}${source ? `  ${source}` : ''}`);
  if (tableLabel) out.push(`Table: ${tableLabel}`);
  if (tokenNo) out.push(`Token: ${tokenNo}`);
  out.push(new Date(createdAt || Date.now()).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }));
  out.push(line('-'));
  for (const it of items) {
    out.push(`${it.qty} x ${it.name}`);
    if (it.note) out.push(`   * ${it.note}`);
  }
  out.push(line('='));
  return out.join('\n');
}

module.exports = {
  listPrinters,
  upsertPrinter,
  deletePrinter,
  queuePrintJob,
  dequeueNext,
  markJobDone,
  requeueStalePrintJobs,
  renderReceiptText,
  renderKotText,
  PRINT_JOB_MAX_ATTEMPTS,
};
