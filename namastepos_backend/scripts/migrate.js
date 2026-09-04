#!/usr/bin/env node
// NamastePOS backend - simple migration runner.
// Reads .sql files in db/migrations/, applies them in order,
// and records applied migrations in a "_migrations" table.

const fs = require('fs');
const path = require('path');
const { pool, query, withTransaction } = require('../src/config/db');
const logger = require('../src/config/logger');

async function ensureMigrationsTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function appliedSet() {
  const r = await query('SELECT name FROM _migrations');
  return new Set(r.rows.map((x) => x.name));
}

// 2026-09-04: two instances booting together (a Render redeploy overlaps the
// old container, or PM2 fans out) both read `_migrations`, both see 083 as
// pending, and both try to apply it — one then fails on the DDL or the
// bookkeeping insert, and a failed deploy on a half-migrated database is the
// worst possible time to find out. A session advisory lock serialises the
// whole runner: the loser waits, then re-reads and finds nothing to do.
const MIGRATE_LOCK_KEY = 421199002; // distinct from the cron lock (…001)

async function run() {
  // Serialise across instances (see MIGRATE_LOCK_KEY above). pg_advisory_lock
  // BLOCKS rather than failing, which is what we want on a rolling deploy.
  const { getClient } = require('../src/config/db');
  const lockClient = await getClient();
  await lockClient.query('SELECT pg_advisory_lock($1)', [MIGRATE_LOCK_KEY]);
  try {
    await ensureMigrationsTable();
    const applied = await appliedSet();

    const dir = path.join(__dirname, '..', 'db', 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

    for (const f of files) {
      if (applied.has(f)) {
        logger.info(`✓ ${f} already applied`);
        continue;
      }
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      logger.info(`→ applying ${f}`);
      try {
      // Review 2026-08-28: run each migration + its _migrations bookkeeping in
      // ONE transaction. Previously a multi-statement file failing partway left
      // the DB half-migrated AND unrecorded — a re-run then re-applied from the
      // top and errored on already-created objects, wedging the deploy. Now a
      // failure rolls the whole file back cleanly. (No migration uses
      // CREATE ... CONCURRENTLY, so wrapping in a txn is safe.)
        await withTransaction(async (client) => {
          await client.query(sql);
          await client.query('INSERT INTO _migrations(name) VALUES ($1)', [f]);
        });
        logger.info(`✓ ${f} applied`);
      } catch (err) {
        logger.error(`✗ ${f} failed (rolled back): ${err.message}`);
        throw err;
      }
    }
  } finally {
    try { await lockClient.query('SELECT pg_advisory_unlock($1)', [MIGRATE_LOCK_KEY]); } catch (_) {}
    try { lockClient.release(); } catch (_) {}
  }
}

// 2026-09-04: `run` is now exported so the server can apply pending
// migrations at BOOT (see src/server.js). Nothing applied migrations
// automatically before this — every deploy shipped code that expected a
// schema no one had migrated yet, and the gap was covered by a human
// remembering. `_migrations` bookkeeping plus the advisory lock above make
// this safe to call from any number of booting instances.
// Only self-execute when invoked directly (`npm run migrate`).
if (require.main === module) {
  run()
    .then(() => pool.end().then(() => process.exit(0)))
    .catch((err) => {
      logger.error(err.message);
      pool.end().then(() => process.exit(1));
    });
}

module.exports = { run };
