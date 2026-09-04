// NamastePOS backend - PostgreSQL connection pool

const { Pool } = require('pg');
const env = require('./env');
const logger = require('./logger');

// TLS config for managed Postgres (Neon, Supabase, RDS…). Set DATABASE_SSL=1
// to enable TLS (2026-08-24). 2026-08-31 (Strix M-1): make server-certificate
// verification available so the DB link is authenticated, not just encrypted.
//   - PG_CA_CERT   → PEM contents or a path to the provider's CA bundle; pins
//                    the cert chain and enables full verification.
//   - DB_SSL_VERIFY=true → verify against Node's built-in trusted-CA store
//                    (works with publicly-trusted providers like Neon).
// Verification is OPT-IN on purpose: a blind default flip could black-hole the
// DB connection on a provider whose cert doesn't chain to a public root, which
// on a live system is a full outage. Enable it once confirmed in staging/prod.
function buildSslConfig() {
  if (!env.DATABASE_SSL) return undefined;
  const caEnv = process.env.PG_CA_CERT;
  if (caEnv && caEnv.trim()) {
    let ca = caEnv;
    if (!caEnv.includes('BEGIN CERTIFICATE')) {
      try { ca = require('fs').readFileSync(caEnv.trim(), 'utf8'); } catch (e) { logger.error('PG_CA_CERT unreadable — falling back to no-verify', { err: e.message }); return { rejectUnauthorized: false }; }
    }
    return { ca, rejectUnauthorized: true };
  }
  if (process.env.DB_SSL_VERIFY === 'true') return { rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: buildSslConfig(),
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
