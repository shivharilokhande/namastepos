// NamastePOS backend - server bootstrap

const env = require('./config/env');
const logger = require('./config/logger');
const buildApp = require('./app');
const { pool } = require('./config/db');
const cronWorker = require('./services/cronWorker');
const onboardingEmail = require('./services/onboardingEmailService');

const app = buildApp();

let server = null;

// NOTE (2026-09-04): do NOT add a migration run here. Render's Start Command
// is already `npm run migrate && npm start`, so migrations are applied by the
// deploy before this process ever binds a port — and the `&&` means a failed
// migration fails the deploy, with Render keeping the previous container
// serving. I briefly added a boot-time run on the false premise that nothing
// migrated automatically; the deploy log (084-086 applied 5:21:32 PM, then
// `> node src/server.js`) shows otherwise. A second run here would only scan
// 86 files again on every free-tier cold start.
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

startListening();

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
