// Own-brand online ordering site settings (Sprint 6 / FF-701)

const { query } = require('../config/db');
const { Conflict } = require('../utils/errors');

async function get(businessId) {
  const r = await query(
    `SELECT * FROM site_settings WHERE business_id = $1`,
    [businessId]
  );
  if (r.rowCount === 0) {
    const ins = await query(
      `INSERT INTO site_settings (business_id) VALUES ($1) RETURNING *`,
      [businessId]
    );
    return ins.rows[0];
  }
  return r.rows[0];
}

async function update(businessId, patch) {
  const allowed = {
    brandSlug: 'brand_slug',
    heroImageUrl: 'hero_image_url',
    primaryColor: 'primary_color',
    brandStory: 'brand_story',
    contactEmail: 'contact_email',
    contactPhone: 'contact_phone',
    address: 'address',
    deliveryRadiusKm: 'delivery_radius_km',
    minOrderInr: 'min_order_paise',
    deliveryFeeInr: 'delivery_fee_paise',
    isPublished: 'is_published',
  };
  const sets = []; const values = []; let idx = 1;
  for (const [k, col] of Object.entries(allowed)) {
    if (patch[k] === undefined) continue;
    let v = patch[k];
    if (k === 'minOrderInr' || k === 'deliveryFeeInr') v = Math.round(v * 100);
    sets.push(`${col} = $${idx++}`);
    values.push(v);
  }
  if (!sets.length) return get(businessId);
  values.push(businessId);
  try {
    const r = await query(
      `INSERT INTO site_settings (business_id) VALUES ($${idx})
       ON CONFLICT (business_id) DO UPDATE SET ${sets.join(', ')}
       RETURNING *`,
      values
    );
    return r.rows[0];
  } catch (err) {
    if (err.code === '23505') throw new Conflict('Brand slug already taken');
    throw err;
  }
}

async function bySlug(slug) {
  // Used by the public ordering site to render menu
  const s = await query(
    `SELECT ss.*, b.id AS biz_id, b.name AS biz_name, b.gstin
       FROM site_settings ss JOIN businesses b ON b.id = ss.business_id
      WHERE ss.brand_slug = $1 AND ss.is_published = TRUE AND b.deleted_at IS NULL
      LIMIT 1`,
    [slug]
  );
  return s.rowCount > 0 ? s.rows[0] : null;
}

module.exports = { get, update, bySlug };
