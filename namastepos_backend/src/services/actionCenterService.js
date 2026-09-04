// NamastePOS — Action Center service (FF-244).
//
// Aggregates everything a business owner needs to look at RIGHT NOW
// into a single response. This is the "unread inbox" for the whole
// business — refunds waiting for approval, items running out of
// stock, disputed / cancelled orders, subscriptions about to expire.
//
// Every list is capped at 10 items to keep the payload small; the
// UI links to the full page for each category.
//
// Called from GET /businesses/:businessId/action-center.

const { query } = require('../config/db');

async function fetch(businessId) {
  // Run the four inbox queries in parallel — this is a hot endpoint
  // (polled by the Overview every 60s) so we want it snappy.
  const [refunds, lowStock, disputed, expiringSubs] = await Promise.all([
    // 1. Refunds pending owner approval. These are SaaS-side (platform)
    //    refunds — refunds table lives in the admin_platform migration
    //    and points to payments -> invoices (subscription charges), NOT
    //    to customer orders. No order relation exists, so we surface
    //    the refund on its own. amount_paise is the correct column.
    query(
      `SELECT r.id, r.amount_paise, r.reason, r.created_at
         FROM refunds r
        WHERE r.business_id = $1
          AND r.status = 'pending'
        ORDER BY r.created_at DESC
        LIMIT 10`,
      [businessId],
    ),

    // 2. Menu items at or below reorder level. Uses is_active (menu_items
    //    has no deleted_at column — active=false is the soft-delete flag).
    query(
      // NP-205 (2026-09-04): only TRACKED items can be "low" (migration 084).
      // Untracked items sit at stock 0 forever, so this card used to be a
      // wall of every dish on the menu for anyone not doing dish-level
      // inventory — which made the whole Action Centre look broken.
      `SELECT id, name, stock, reorder_level, unit
         FROM menu_items
        WHERE business_id = $1
          AND is_active = TRUE
          AND track_stock = TRUE
          AND reorder_level IS NOT NULL
          AND stock <= reorder_level
        ORDER BY stock ASC
        LIMIT 10`,
      [businessId],
    ),

    // 3. Cancelled orders in the last 24 hours with a reason attached.
    //    orders has no cancelled_at column, so we use updated_at as
    //    the cancellation timestamp (safe because status only flips to
    //    cancelled inside updateStatus which sets updated_at = NOW()).
    query(
      `SELECT id, order_no, total, cancel_reason, updated_at AS cancelled_at
         FROM orders
        WHERE business_id = $1
          AND status = 'cancelled'
          AND updated_at > NOW() - INTERVAL '24 hours'
          AND cancel_reason IS NOT NULL
        ORDER BY updated_at DESC
        LIMIT 10`,
      [businessId],
    ),

    // 4. Subscriptions ending in the next 7 days (either trial ends
    //    or paid renewal). Owners want a heads-up before the trial
    //    expires so they can upgrade or cancel deliberately.
    query(
      `SELECT id, status, trial_ends_at, current_period_end
         FROM subscriptions
        WHERE business_id = $1
          AND status IN ('trialing','active')
          AND (
                (trial_ends_at IS NOT NULL AND trial_ends_at BETWEEN NOW() AND NOW() + INTERVAL '7 days')
             OR (status = 'active' AND current_period_end BETWEEN NOW() AND NOW() + INTERVAL '3 days')
          )
        LIMIT 10`,
      [businessId],
    ),
  ]);

  return {
    refunds: refunds.rows.map((r) => ({
      id: r.id,
      // Bug fix: refunds table stores paise, not rupees.
      amount: (parseInt(r.amount_paise, 10) || 0) / 100,
      reason: r.reason,
      createdAt: r.created_at,
    })),
    lowStock: lowStock.rows.map((r) => ({
      id: r.id,
      name: r.name,
      stock: parseFloat(r.stock) || 0,
      reorderLevel: parseFloat(r.reorder_level) || 0,
      unit: r.unit,
    })),
    disputed: disputed.rows.map((r) => ({
      id: r.id,
      orderNo: r.order_no,
      total: parseFloat(r.total) || 0,
      reason: r.cancel_reason,
      cancelledAt: r.cancelled_at,
    })),
    expiringSubs: expiringSubs.rows.map((r) => ({
      id: r.id,
      status: r.status,
      trialEndsAt: r.trial_ends_at,
      currentPeriodEnd: r.current_period_end,
    })),
    // A single number the UI can badge on the sidebar.
    counts: {
      refunds: refunds.rowCount,
      lowStock: lowStock.rowCount,
      disputed: disputed.rowCount,
      expiringSubs: expiringSubs.rowCount,
      total: refunds.rowCount + lowStock.rowCount + disputed.rowCount + expiringSubs.rowCount,
    },
  };
}

module.exports = { fetch };
