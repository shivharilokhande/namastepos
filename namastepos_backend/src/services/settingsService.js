// NamastePOS backend - platform settings KV store

const { query } = require('../config/db');

async function getAll() {
  const r = await query(`SELECT * FROM platform_settings ORDER BY key`);
  return r.rows.map((row) => ({
    key: row.key,
    value: row.value,
    description: row.description,
    updatedAt: row.updated_at,
  }));
}

async function get(key) {
  const r = await query(`SELECT value FROM platform_settings WHERE key = $1`, [key]);
  return r.rowCount > 0 ? r.rows[0].value : null;
}

async function getMany(keys) {
  const r = await query(
    `SELECT key, value FROM platform_settings WHERE key = ANY($1::text[])`,
    [keys]
  );
  return Object.fromEntries(r.rows.map((row) => [row.key, row.value]));
}

async function set(key, value, { adminId, description } = {}) {
  const r = await query(
    `INSERT INTO platform_settings (key, value, description, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value,
           description = COALESCE(EXCLUDED.description, platform_settings.description),
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()
     RETURNING *`,
    [key, JSON.stringify(value), description || null, adminId || null]
  );
  return r.rows[0];
}

async function bulkSet(map, { adminId } = {}) {
  for (const [k, v] of Object.entries(map)) {
    await set(k, v, { adminId });
  }
  return getAll();
}

module.exports = { getAll, get, getMany, set, bulkSet };
