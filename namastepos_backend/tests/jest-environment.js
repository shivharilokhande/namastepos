// NamastePOS backend — Node test environment that drains pg pools per file.
//
// Why this exists: with `--runInBand` all 79 test files share one Node process,
// but each file gets its own Jest module registry and therefore its own
// `new Pool` (src/config/db builds it at import time). Nothing used to close
// those pools — `closePool()` in tests/setup.js was a no-op and
// tests/globalTeardown.js ended a pool it had built in a third registry and
// never used. Sockets accumulated across files until Postgres answered
// "remaining connection slots are reserved for non-replication superuser
// connections", failing whichever suite happened to be running at that moment.
//
// `teardown()` runs after the test file's last hook, so ending the pool here
// can never race a suite's own afterAll. tests/pool-registry.js collects the
// pools onto the context global for us to find.

// eslint-disable-next-line import/no-extraneous-dependencies
const { TestEnvironment: NodeEnvironment } = require('jest-environment-node');

class PostgresAwareNodeEnvironment extends NodeEnvironment {
  async teardown() {
    const pools = this.global && this.global.__NAMASTEPOS_TEST_POOLS__;
    if (pools) {
      for (const pool of pools) {
        // `ending` is set by pg-pool the moment end() is called, so a suite
        // that already closed its own pool via closePool() is a no-op here.
        // eslint-disable-next-line no-await-in-loop
        if (!pool.ending) await pool.end().catch(() => {});
      }
      pools.clear();
    }
    await super.teardown();
  }
}

module.exports = PostgresAwareNodeEnvironment;
