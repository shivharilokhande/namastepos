// NamastePOS backend - server bootstrap

const env = require('./config/env');
const logger = require('./config/logger');
const buildApp = require('./app');
const { pool } = require('./config/db');
const cronWorker = require('./services/cronWorker');
const onboardingEmail = require('./services/onboardingEmailService');

const migrator = require('../scripts/migrate');

const app = buildApp();

let server = null;

// 2026-09-04 — apply pending migrations BEFORE serving traffic.
//
// Nothing did this before: `npm run migrate` was a manual step, so every
// deploy put code live against whatever schema happened to be there. The
// failure mode is silent and expensive — new code SELECTs a column that
// doesn't exist yet and the money path 500s, which is exactly how "migration
// 062 must be run on prod" sat open for a week. Booting is the one moment we
// know the code and the schema must agree.
//
// It does NOT fail-fast by default, and that is a considered choice. The
// first local smoke test of this code found a database whose `_migrations`
// bookkeeping disagreed with its actual schema, so the runner tried to apply
// 002 onto a populated table and threw. If prod's bookkeeping is off by even
// one row, exiting here would take a live POS down at dinner service to fix a
// problem that is not yet hurting anyone. So: apply, and on failure keep
// serving the old-but-working code path while marking /health `degraded` with
// the error — visible to the keep-alive worker, the admin health page and the
// nightly integrity mail. Set MIGRATE_ON_BOOT_STRICT=true to make it fatal
// once one clean deploy has proven the bookkeeping is sound; set
// MIGRATE_ON_BOOT=false to skip it entirely.
// Concurrency is already handled — scripts/migrate.js takes a Postgres
// advisory lock, so overlapping containers serialise instead of racing.
async function boot() {
  const skip = env.NODE_ENV === 'test' || process.env.MIGRATE_ON_BOOT === 'false';
  if (!skip) {
    try {
      logger.info('Applying pending migrations before accepting traffic…');
      await migrator.run();
      logger.info('Migrations up to date');
    } catch (e) {
      app.locals.migrationError = e.message;
      logger.error(`Boot migrations FAILED — serving anyway, /health is degraded: ${e.message}`);
      if (process.env.MIGRATE_ON_BOOT_STRICT === 'true') {
        logger.error('MIGRATE_ON_BOOT_STRICT=true — refusing to serve');
        process.exit(1);
      }
    }
  }
  startListening();
}

function startListening() {
  server = app.listen(env.PORT, () => {
    logger.info(`NamastePOS API listening on :${env.PORT} (${env.NODE_ENV})`);
    logger.info(`Mounted at ${env.API_PREFIX}/...`);
    // CRITICAL FIX (2026-08-23, review C2): under PM2 cluster mode
    // (`instances: 'max'`) every worker used to start the schedulers —
    // N workers ⇒ N× duplicate recurring invoices, birthday WhatsApps and
    // digest sends. Only PM2 instance 0 (or a bare `node src/server.js`
    // run, where NODE_APP_INSTANCE is unset) runs them now.
    const isSchedulerInstance = process.env.NODE_APP_INSTANCE === undefined
      || process.env.NODE_APP_INSTANCE === '0';
    if (env.NODE_ENV !== 'test' && isSchedulerInstance) {
      cronWorker.start({ intervalMs: 60_000 });
      // FF-223: D3 + D7 onboarding email scheduler. Hourly tick. Soft
      // no-op when SMTP is unconfigured.
      onboardingEmail.startScheduler();
      logger.info('Schedulers started on this instance (leader)');
    } else if (env.NODE_ENV !== 'test') {
      logger.info(`Schedulers skipped on worker instance ${process.env.NODE_APP_INSTANCE}`);
    }
  });
}

boot();

// Graceful shutdown
function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down…`);
  // A SIGTERM can land while boot migrations are still running, before the
  // listener exists — drain the pool and go, don't throw on a null server.
  if (!server) {
    pool.end()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
    return;
  }
  server.close((err) => {
    if (err) {
      logger.error('Error during server close', { err: err.message });
      process.exit(1);
    }
    pool.end()
      .then(() => { logger.info('PG pool drained, exiting'); process.exit(0); })
      .catch((e) => { logger.error('PG pool drain failed', { err: e.message }); process.exit(1); });
  });
  // hard exit after 10s
  setTimeout(() => {
    logger.error('Force exit after 10s');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason: String(reason) });
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { err: err.message, stack: err.stack });
});
