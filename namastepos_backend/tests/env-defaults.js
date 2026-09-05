// NamastePOS backend — environment defaults for every test file.
//
// Registered as Jest `setupFiles`, which runs once per test FILE, after the
// test environment exists but BEFORE the test file itself — and therefore
// before the test file's first `require`. That timing is the point.
//
// These values used to live at the top of tests/setup.js, which only works if
// a suite requires `../setup` before it requires anything under `src/`. 40 of
// the 61 DB-backed suites do the opposite (`require('../../src/config/db')` on
// a line above `require('../setup')`), so the pg Pool — built at import time
// from these vars — was already constructed with whatever the developer's
// `.env` happened to say. Setting them here makes the sizing identical for
// every suite, locally and in CI.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.GOOGLE_CLIENT_IDS = 'test-client.apps.googleusercontent.com';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL = process.env.DATABASE_URL
  || 'postgresql://namastepos:namastepos@localhost:5432/namastepos_test';

// Pool sizing for tests — FORCED, not defaulted, so a local `.env` or a CI
// default cannot change how many sockets a suite may open.
//
//   DB_POOL_MIN=0  pg-pool only reaps an idle client while
//                  `_clients.length > options.min` (pg-pool/index.js
//                  `_isAboveMin`). The repo `.env` ships DB_POOL_MIN=2 and the
//                  env.js default is 5, either of which is >= the old test max
//                  of 2 — so idle connections were pinned open for the whole
//                  run and never timed out. With min 0 the idle timeout works.
//
//   DB_POOL_MAX=10 This is NOT what bounds total connections any more; each
//                  test file's pool is closed in environment teardown (see
//                  tests/jest-environment.js), so at most one file's pool is
//                  ever open. The cap only has to be roomy enough that a
//                  nested `query()` inside `withTransaction` (which is holding
//                  a client) cannot starve the pool. 10 is what the majority of
//                  suites already ran with.
process.env.DB_POOL_MIN = '0';
process.env.DB_POOL_MAX = '10';
