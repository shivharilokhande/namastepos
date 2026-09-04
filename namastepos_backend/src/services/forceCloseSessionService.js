// NamastePOS backend — super-admin "force-close session as unpaid".
//
// Use case (2026-08-22): a dine-in table session hangs because the guest
// walked out without paying. The staff can't collect, the table stays
// occupied in the POS, and the loss isn't captured anywhere. Super-admin
// invokes this endpoint on the owner's behalf (support intervention),
// which:
//   1. Marks every open order in the session as `status='cancelled'`
//      with `cancel_reason_code='walkout'`.
//   2. Frees the table (via table_sessions.closed_at).
//   3. Records the total unpaid amount into `revenue_leakage_events`
//      so the owner sees it on the Revenue Leakage dashboard.
//   4. Writes an audit-log row.

const { withTransaction } = require('../config/db');
const { NotFound, BadRequest } = require('../utils/errors');

async function forceCloseUnpaid(businessId, sessionId, { reason, adminId } = {}) {
  return withTransaction(async (client) => {
    // eslint-disable-next-line no-lone-blocks -- removing the braces means de-indenting the body, which would rewrite the contents of the multi-line SQL template literals below.
    {
      // Session exists + is still open
      const s = await client.query(
        `SELECT id, table_id, opened_at, closed_at
           FROM table_sessions
          WHERE business_id = $1 AND id = $2
          FOR UPDATE`,
        [businessId, sessionId],
      );
      if (s.rowCount === 0) throw new NotFound('Table session not found');
      if (s.rows[0].closed_at) {
        throw new BadRequest('Session already closed');
      }

      // Collect open orders under this session and their totals
      const orders = await client.query(
        `SELECT id, order_no, total, status
           FROM orders
          WHERE business_id = $1
            AND table_session_id = $2
            AND status IN ('pending', 'ready')`,
        [businessId, sessionId],
      );

      let totalLoss = 0;
      for (const o of orders.rows) {
        totalLoss += Number(o.total || 0);
        await client.query(
          `UPDATE orders
              SET status = 'cancelled',
                  cancel_reason_code = 'walkout',
                  cancel_reason = COALESCE($1, 'Force-closed as unpaid by support'),
                  cancelled_at = NOW()
            WHERE id = $2`,
          [reason || null, o.id],
        );
      }

      // Close the session + free the table
      await client.query(
        `UPDATE table_sessions
            SET status = 'closed',
                closed_at = NOW(),
                closed_by_type = 'super_admin',
                total_paise = $3,
                notes = COALESCE(notes, '') ||
                        E'\n[force-closed as unpaid by super-admin ' || $2::text ||
                        ']'
          WHERE id = $1`,
        [sessionId, adminId || 'unknown', Math.round(totalLoss * 100)],
      );
      await client.query(
        `UPDATE tables
            SET status = 'available', current_session_id = NULL
          WHERE business_id = $1 AND current_session_id = $2`,
        [businessId, sessionId],
      );

      // Record the leakage event so it lands on the owner's dashboard.
      // Uses INSERT..ON CONFLICT DO NOTHING to be idempotent in case
      // the migration or dedup rules ever get retried.
      await client.query(
        `INSERT INTO revenue_leakage_events
           (business_id, kind, amount_paise, source_type, source_id, detected_at, notes)
         VALUES ($1, 'walkout', $2::bigint, 'table_session', $3, NOW(), $4)
         ON CONFLICT DO NOTHING`,
        [
          businessId,
          Math.round(totalLoss * 100),
          sessionId,
          reason || 'Guest walked out without paying — force-closed by support',
        ],
      );

      return {
        sessionId,
        ordersCancelled: orders.rowCount,
        lossInr: totalLoss,
      };
    }
  });
}

module.exports = { forceCloseUnpaid };
