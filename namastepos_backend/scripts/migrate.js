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

async function run() {
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
}

run()
  .then(() => pool.end().then(() => process.exit(0)))
  .catch((err) => {
    logger.error(err.message);
    pool.end().then(() => process.exit(1));
  });
