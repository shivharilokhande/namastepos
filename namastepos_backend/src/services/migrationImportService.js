// NamastePOS — "Switch to NamastePOS" migration imports (2026-09-03).
//
// Two row handlers for the /imports hub in operations.routes.js:
//
//   importCustomerRow — upsert a customer by (business_id, phone) and book
//     opening loyalty-points / wallet balances exported from a previous POS.
//     Balances go through the EXISTING ledgers (loyalty_transactions,
//     wallet_ledger) with kind 'import_opening' — never a raw column poke —
//     so audit trails, DPDP export and revenue-recognition math stay intact.
//     IDEMPOTENT: re-running the same CSV updates profile fields but skips
//     the opening entries when an 'import_opening' entry already exists for
//     that customer (per-row warning instead of double-booking).
//
//   importSalesRow — one AGGREGATE order per historical day (source 'other',
//     channel 'import', status 'collected') so old sales history shows up in
//     the daily reports / revenue SUMs for reference. Deliberately a direct
//     INSERT, NOT orderService.create: historical sales must not re-fire
//     inventory deductions, loyalty earn, coupon caps or WhatsApp side
//     effects. IDEMPOTENT: collected_at (and created_at — reports bucket by
//     created_at in IST) is pinned to noon IST of the day, and the partial
//     unique index uq_orders_import_day (migration 075) on
//     (business_id, collected_at) WHERE channel='import' makes a re-run of
//     the same date skip with a warning.

const { withTransaction } = require('../config/db');
const { BadRequest } = require('../utils/errors');
const gc = require('./giftCardService');
const { nextOrderNo } = require('./orderService');

const r2 = (v) => Math.round(Number(v) * 100) / 100;

// Today's date in IST — sales history must be strictly in the past so an
// imported "today" can never collide with (or inflate) the live Z-report.
function todayIst() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * Upsert one customer row from the migration CSV.
 * Returns { warnings: string[] } — warnings are per-row, non-fatal.
 */
async function importCustomerRow(businessId, row) {
  const tags = typeof row.tags === 'string'
    ? row.tags.split(/[,;|]/).map((t) => t.trim()).filter(Boolean)
    : null;
  const whatsappOptIn = row.whatsappOptIn === undefined ? null : row.whatsappOptIn;

  return withTransaction(async (c) => {
    const warnings = [];

    // Upsert by (business_id, phone) — uq_customers. COALESCE keeps existing
    // profile values when the CSV cell is blank (blank must never wipe data).
    const up = await c.query(
      `INSERT INTO customers (business_id, phone, name, email, tags, notes, marketing_optin)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, TRUE))
       ON CONFLICT (business_id, phone) DO UPDATE SET
         name            = COALESCE(EXCLUDED.name,  customers.name),
         email           = COALESCE(EXCLUDED.email, customers.email),
         tags            = COALESCE(EXCLUDED.tags,  customers.tags),
         notes           = COALESCE(EXCLUDED.notes, customers.notes),
         marketing_optin = COALESCE($7, customers.marketing_optin)
       RETURNING id`,
      [businessId, row.phone, row.name || null, row.email || null,
        tags && tags.length ? tags : null, row.notes || null, whatsappOptIn],
    );
    const customerId = up.rows[0].id;

    // ── Opening loyalty points — via the points ledger ──────────────────
    const points = Math.round(Number(row.loyaltyPoints || 0));
    if (points > 0) {
      const prior = await c.query(
        `SELECT 1 FROM loyalty_transactions
          WHERE business_id = $1 AND customer_id = $2 AND kind = 'import_opening'
          LIMIT 1`,
        [businessId, customerId],
      );
      if (prior.rowCount > 0) {
        warnings.push('Loyalty opening balance already imported — skipped');
      } else {
        // Row lock so balance_after can't drift under concurrent imports —
        // same locking pattern as loyaltyService.earn().
        const cust = await c.query(
          `SELECT points_balance FROM customers
            WHERE id = $1 AND business_id = $2 FOR UPDATE`,
          [customerId, businessId],
        );
        const balanceAfter = Number(cust.rows[0].points_balance) + points;
        await c.query(
          `INSERT INTO loyalty_transactions
             (business_id, customer_id, kind, points, balance_after, note)
           VALUES ($1, $2, 'import_opening', $3, $4, 'Opening balance from previous POS')`,
          [businessId, customerId, points, balanceAfter],
        );
        await c.query(
          `UPDATE customers
              SET points_balance  = points_balance + $1,
                  lifetime_points = lifetime_points + $1
            WHERE id = $2 AND business_id = $3`,
          [points, customerId, businessId],
        );
      }
    }

    // ── Opening wallet balance — via the wallet ledger ──────────────────
    // Wallet money is deferred revenue: the opening balance books as a
    // CREDIT ledger entry with the distinct kind 'import_opening' (vs
    // 'credit_top_up' for real top-ups), so revenue-recognition math can
    // tell migrated liability from money actually collected here.
    const walletPaise = Math.round(Number(row.walletBalanceInr || 0) * 100);
    if (walletPaise > 0) {
      const prior = await c.query(
        `SELECT 1 FROM wallet_ledger
          WHERE business_id = $1 AND customer_id = $2 AND kind = 'import_opening'
          LIMIT 1`,
        [businessId, customerId],
      );
      if (prior.rowCount > 0) {
        warnings.push('Wallet opening balance already imported — skipped');
      } else {
        await gc.creditWalletTx(c, businessId, customerId, walletPaise, {
          reason: 'import_opening',
          note: 'Opening balance from previous POS',
        });
      }
    }

    return { warnings };
  });
}

/**
 * Insert one aggregate historical-sales order (one row = one past day).
 * Returns {} on success, { skipped: true, warning } when the date was
 * already imported.
 */
async function importSalesRow(businessId, row) {
  const { date } = row;
  const orders = Math.round(Number(row.orders));
  const grossInr = Number(row.grossInr);
  const discountInr = Number(row.discountInr || 0);
  const taxInr = Number(row.taxInr || 0);

  if (date >= todayIst()) {
    throw new BadRequest('date must be a past date (YYYY-MM-DD)');
  }
  if (discountInr > grossInr) throw new BadRequest('discountInr cannot exceed grossInr');
  if (taxInr > grossInr) throw new BadRequest('taxInr cannot exceed grossInr');

  // Money mapping (orders are NUMERIC INR, rounded to the paise):
  //   subtotal = gross − tax, tax = taxInr, discount = discountInr,
  //   total = gross − discount  (so subtotal + tax − discount = total).
  const subtotal = r2(grossInr - taxInr);
  const tax = r2(taxInr);
  const discount = r2(discountInr);
  const total = r2(grossInr - discountInr);
  const ts = `${date}T12:00:00+05:30`; // noon IST of the historical day

  return withTransaction(async (c) => {
    // Cheap pre-check so re-runs don't burn an order_no per skipped date.
    const dup = await c.query(
      `SELECT 1 FROM orders
        WHERE business_id = $1 AND channel = 'import' AND collected_at = $2::timestamptz
        LIMIT 1`,
      [businessId, ts],
    );
    if (dup.rowCount > 0) {
      return { skipped: true, warning: `Sales for ${date} already imported — skipped` };
    }

    const orderNo = await nextOrderNo(c, businessId);
    // created_at is set to the historical day too — every report buckets by
    // (created_at AT TIME ZONE 'Asia/Kolkata')::date, so the imported day
    // must not land on "today". ON CONFLICT (uq_orders_import_day) is the
    // race-proof belt behind the pre-check above.
    const ins = await c.query(
      `INSERT INTO orders
         (business_id, order_no, source, channel, status, payment_method,
          subtotal, tax, discount, total,
          created_at, updated_at, collected_at)
       VALUES ($1, $2, 'other', 'import', 'collected', 'cash',
               $3, $4, $5, $6,
               $7::timestamptz, $7::timestamptz, $7::timestamptz)
       ON CONFLICT (business_id, collected_at) WHERE channel = 'import' DO NOTHING
       RETURNING id`,
      [businessId, orderNo, subtotal, tax, discount, total, ts],
    );
    if (ins.rowCount === 0) {
      return { skipped: true, warning: `Sales for ${date} already imported — skipped` };
    }
    await c.query(
      `INSERT INTO order_items (order_id, menu_item_id, name, price, qty)
       VALUES ($1, NULL, $2, $3, 1)`,
      [ins.rows[0].id, `Imported sales (${orders} orders)`, total],
    );
    return {};
  });
}

module.exports = { importCustomerRow, importSalesRow };
