// NamastePOS — PM2 cluster config.
//
// Fixes production blocker #2 from PRODUCTION_READINESS.md — a single
// Node process was wasting half the vCPU on any multi-core VM. This
// config spawns one worker per CPU core (`exec_mode: 'cluster'`) and
// wires Node's cluster module through PM2's built-in load balancer.
//
// Run:
//   pm2 start ecosystem.config.js
//   pm2 startup && pm2 save    (auto-restart on VM reboot)
//   pm2 monit                  (live dashboard)
//   pm2 logs                   (tail all workers)
//
// Zero-downtime reloads:
//   pm2 reload namastepos-api    (drains + restarts one worker at a time)
//
// Rollback plan: `pm2 stop namastepos-api && node src/server.js`
// (single-process fallback). Nothing in the app code depends on cluster
// mode — the JWT is stateless, the DB pool is per-worker, and the
// in-process report cache is per-worker (will re-warm on first hit).

module.exports = {
  apps: [
    {
      name: 'namastepos-api',
      script: 'src/server.js',

      // One worker per CPU core. `max` = os.cpus().length.
      instances: 'max',
      exec_mode: 'cluster',

      // Restart if RSS climbs past 800MB — a safety net for a slow
      // memory leak. Won't fire under normal load; Node's V8 heap
      // for our workload usually sits ~150-250 MB per worker.
      max_memory_restart: '800M',

      // Environment. Anything set in the real .env still wins because
      // dotenv loads before this file is consulted.
      env: {
        NODE_ENV: 'production',
        // These defaults kick in only if .env doesn't override.
        DB_POOL_MAX: '30',
        RATE_LIMIT_MAX: '600',
      },

      // If a worker crashes 10 times in a row without staying up for
      // at least 10 s, stop trying — PM2 will surface the loop in
      // `pm2 logs` and page the operator instead of blindly restarting.
      max_restarts: 10,
      min_uptime: '10s',

      // Sink stdout + stderr into these files. Rotate via `pm2 install
      // pm2-logrotate` (10MB rolling, keep 7 days).
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-err.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      // Graceful shutdown — Node gets 5s to drain in-flight requests
      // after `pm2 reload` before PM2 sends SIGKILL. Our server.js
      // already handles SIGTERM correctly (drains PG pool, exits 0).
      kill_timeout: 5000,
    },
  ],
};
