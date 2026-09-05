// NamastePOS backend — track every pg Pool a test file opens.
//
// Registered as Jest `setupFilesAfterEnv`, so it runs inside the test file's
// own module registry, before the test file itself. Jest gives every test FILE
// a fresh registry, which means every file that requires `src/config/db`
// constructs its OWN `new Pool` — pools are not shared between files, whatever
// tests/setup.js used to claim, and nothing but the file that opened a pool can
// close it.
//
// Two constraints shape this file:
//
//  1. It must NOT require anything under `src/`. Several suites deliberately
//     set process.env (RAZORPAY_WEBHOOK_SECRET, TOTP_ENC_KEY, TRIAL_PLAN_TIER,
//     JWT_SECRET…) on their first lines because `src/config/env` snapshots the
//     environment at import time. Pulling src/config/db in from here would
//     freeze env before the suite got its turn. Patching `pg` instead touches
//     nothing of ours, and catches the pool whenever db.js is finally required.
//
//  2. It must not close the pool from an `afterAll` here. jest-circus runs the
//     afterAll hooks of a block in declaration order (jest-circus/build/run.js),
//     and a hook registered from setupFilesAfterEnv is declared before the
//     suite's own — the pool would end while a suite's afterAll still had DB
//     work to do. The custom environment's teardown() runs strictly after every
//     hook in the file, so that is where the closing happens.
//
// Registering here rather than in tests/setup.js also means a suite cannot
// forget: the pool is tracked whether or not the suite calls closePool().

// eslint-disable-next-line import/no-extraneous-dependencies
const pg = require('pg');

const pools = new Set();
globalThis.__NAMASTEPOS_TEST_POOLS__ = pools;

const BasePool = pg.Pool;

class TrackedPool extends BasePool {
  constructor(...args) {
    super(...args);
    pools.add(this);
  }
}

pg.Pool = TrackedPool;
