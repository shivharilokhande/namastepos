// NamastePOS backend - PostgreSQL connection pool

const { Pool } = require('pg');
const env = require('./env');
const logger = require('./logger');

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  // Managed Postgres providers (Neon, Supabase, RDS…) require TLS.
  // Set DATABASE_SSL=1 in the environment to enable it (2026-08-24).
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
  min: env.DB_POOL_MIN,
  max: env.DB_POOL_MAX,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  logger.error('Unexpected PG pool error', { err: err.message });
});

/** Run a parameterised query. Throws on error. */
async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const ms = Date.now() - start;
    if (ms > 200) logger.warn('Slow query', { text, ms });
    return res;
  } catch (err) {
    logger.error('Query failed', { text, err: err.message });
    throw err;
  }
}

/** Acquire a single client (caller MUST call client.release()). */
async function getClient() {
  return pool.connect();
}

/** Helper to wrap a function in BEGIN / COMMIT / ROLLBACK. */
async function withTransaction(fn) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, getClient, withTransaction };
