// Customer history at order time (Sprint 3 / FF-504)

const { query } = require('../config/db');

async function profileForCashier(businessId, phone) {
  // Mask email partially for non-admin staff (data minimisation)
  const cust = await query(
    `SELECT id, name, phone, email, birthday, tier,
            points_balance, total_orders, total_spent,
            first_order_at, last_order_at, notes,
            wallet_balance_paise
       FROM customers
      WHERE business_id = $1 AND phone = $2 LIMIT 1`,
    [businessId, phone]
  );
  if (cust.rowCount === 0) return null;
  const c = cust.rows[0];

  // Recent orders + most-ordered items
  const recent = await query(
    `SELECT id, order_no, created_at, total, status
       FROM orders
      WHERE business_id = $1 AND customer_id = $2
      ORDER BY created_at DESC LIMIT 5`,
    [businessId, c.id]
  );

  const favourites = await query(
    `SELECT oi.menu_item_id, oi.name, COUNT(*)::int AS n,
            SUM(oi.qty)::int AS qty_total
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE o.business_id = $1 AND o.customer_id = $2
      GROUP BY oi.menu_item_id, oi.name
      ORDER BY n DESC LIMIT 5`,
    [businessId, c.id]
  );

  // Active membership (2026-08-23: include the remaining bundle so the
  // customer screen can show "12 of 20 cold coffees left")
  const membership = await query(
    `SELECT m.name, ms.expires_at, m.benefits, ms.remaining
       FROM membership_subscriptions ms
       JOIN memberships m ON m.id = ms.membership_id
      WHERE ms.business_id = $1 AND ms.customer_id = $2
        AND ms.status = 'active' AND ms.expires_at > NOW()
      ORDER BY ms.expires_at DESC LIMIT 1`,
    [businessId, c.id]
  );

  // Mask email if present
  const maskedEmail = c.email
    ? c.email.replace(/^([^@]).*(@.*)/, '$1***$2')
    : null;

  return {
    customer: {
      id: c.id, name: c.name, phone: c.phone,
      emailMasked: maskedEmail, birthday: c.birthday,
      tier: c.tier, pointsBalance: c.points_balance,
      totalOrders: c.total_orders, totalSpent: parseFloat(c.total_spent),
      firstOrderAt: c.first_order_at, lastOrderAt: c.last_order_at,
      notes: c.notes, walletInr: (c.wallet_balance_paise || 0) / 100,
    },
    recentOrders: recent.rows,
    favourites: favourites.rows,
    activeMembership: membership.rows[0] || null,
  };
}

async function reorderSameAsLast(businessId, customerId) {
  const last = await query(
    `SELECT id FROM orders
      WHERE business_id = $1 AND customer_id = $2 AND status <> 'cancelled'
      ORDER BY created_at DESC LIMIT 1`,
    [businessId, customerId]
  );
  if (last.rowCount === 0) return [];
  const items = await query(
    `SELECT menu_item_id, name, price, qty
       FROM order_items WHERE order_id = $1`,
    [last.rows[0].id]
  );
  return items.rows.map((r) => ({
    menuItemId: r.menu_item_id,
    name: r.name,
    price: parseFloat(r.price),
    qty: parseFloat(r.qty),
  }));
}

module.exports = { profileForCashier, reorderSameAsLast };
