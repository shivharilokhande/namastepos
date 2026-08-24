// NamastePOS — Per-tenant bill template (Sprint 1 / FF-306).

const { query } = require('../config/db');

function serialize(r) {
  if (!r) return null;
  return {
    businessId: r.business_id,
    logoUrl: r.logo_url,
    headerLines: r.header_lines || [],
    gstin: r.gstin,
    fssaiNo: r.fssai_no,
    footerText: r.footer_text,
    showToken: r.show_token,
    showTaxBreakdown: r.show_tax_breakdown,
    paperWidthMm: r.paper_width_mm,
    updatedAt: r.updated_at,
  };
}

async function get(businessId) {
  const r = await query(
    `SELECT * FROM bill_templates WHERE business_id = $1`, [businessId]
  );
  if (r.rowCount === 0) {
    // Lazy-create defaults so the editor has something to render
    const ins = await query(
      `INSERT INTO bill_templates (business_id) VALUES ($1)
       ON CONFLICT DO NOTHING RETURNING *`,
      [businessId]
    );
    return serialize(ins.rows[0] || (await query(
      `SELECT * FROM bill_templates WHERE business_id = $1`, [businessId]
    )).rows[0]);
  }
  return serialize(r.rows[0]);
}

async function update(businessId, patch) {
  const allowed = {
    logoUrl: 'logo_url',
    headerLines: 'header_lines',
    gstin: 'gstin',
    fssaiNo: 'fssai_no',
    footerText: 'footer_text',
    showToken: 'show_token',
    showTaxBreakdown: 'show_tax_breakdown',
    paperWidthMm: 'paper_width_mm',
  };
  const sets = []; const values = []; let idx = 1;
  for (const [k, col] of Object.entries(allowed)) {
    if (patch[k] !== undefined) {
      sets.push(`${col} = $${idx++}`);
      values.push(patch[k]);
    }
  }
  if (sets.length === 0) return get(businessId);
  values.push(businessId);
  const r = await query(
    `INSERT INTO bill_templates (business_id) VALUES ($${idx})
     ON CONFLICT (business_id) DO UPDATE SET ${sets.join(', ')}
     RETURNING *`,
    values
  );
  return serialize(r.rows[0]);
}

module.exports = { get, update, serialize };
