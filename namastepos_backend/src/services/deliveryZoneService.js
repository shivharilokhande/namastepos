// NamastePOS — Delivery zones + fee lookup (FF-331).
//
// Cafes serving their own delivery need to tell the guest QR site
// "your pincode is in Zone B, delivery is ₹40, min order ₹250".
// This service owns:
//   • CRUD for zones
//   • pincode → zone resolver used by GuestMenuPage during checkout

const { query } = require('../config/db');
const { BadRequest, NotFound } = require('../utils/errors');

async function list(businessId) {
  const r = await query(
    `SELECT * FROM delivery_zones
      WHERE business_id = $1 AND is_active = TRUE
      ORDER BY display_order, name`,
    [businessId],
  );
  return r.rows.map((z) => ({
    id: z.id,
    name: z.name,
    feeInr: parseFloat(z.fee_inr_paise) / 100,
    minOrderInr: parseFloat(z.min_order_inr_paise) / 100,
    pincodes: z.pincodes || [],
  }));
}

async function upsert(businessId, body) {
  const { id, name, feeInr = 0, minOrderInr = 0, pincodes = [], displayOrder = 100 } = body;
  if (!name) throw new BadRequest('Zone name required');
  const feePaise = Math.round(feeInr * 100);
  const minPaise = Math.round(minOrderInr * 100);
  if (id) {
    const r = await query(
      `UPDATE delivery_zones
          SET name = $1, fee_inr_paise = $2, min_order_inr_paise = $3,
              pincodes = $4::text[], display_order = $5
        WHERE business_id = $6 AND id = $7 RETURNING *`,
      [name, feePaise, minPaise, pincodes, displayOrder, businessId, id],
    );
    if (r.rowCount === 0) throw new NotFound('Zone not found');
    return r.rows[0];
  }
  const r = await query(
    `INSERT INTO delivery_zones
       (business_id, name, fee_inr_paise, min_order_inr_paise,
        pincodes, display_order)
     VALUES ($1, $2, $3, $4, $5::text[], $6) RETURNING *`,
    [businessId, name, feePaise, minPaise, pincodes, displayOrder],
  );
  return r.rows[0];
}

async function remove(businessId, id) {
  await query(
    `UPDATE delivery_zones SET is_active = FALSE
      WHERE business_id = $1 AND id = $2`,
    [businessId, id],
  );
}

/**
 * Called from the guest checkout page: given a pincode, return the
 * cheapest matching zone, or null if none.
 */
async function resolveForPincode(businessId, pincode) {
  if (!pincode) return null;
  const r = await query(
    `SELECT * FROM delivery_zones
      WHERE business_id = $1
        AND is_active = TRUE
        AND $2 = ANY(pincodes)
      ORDER BY fee_inr_paise ASC
      LIMIT 1`,
    [businessId, String(pincode).trim()],
  );
  if (r.rowCount === 0) return null;
  const z = r.rows[0];
  return {
    id: z.id,
    name: z.name,
    feeInr: parseFloat(z.fee_inr_paise) / 100,
    minOrderInr: parseFloat(z.min_order_inr_paise) / 100,
  };
}

module.exports = { list, upsert, remove, resolveForPincode };
