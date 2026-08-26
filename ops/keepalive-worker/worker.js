// NamastePOS keep-alive — Cloudflare Worker (Cron Trigger).
//
// Render's free web service spins down after ~15 min idle, so the first
// request after a lull takes 60–90s (looks like the app "crashed"). This
// Worker pings /health every 5 minutes to keep the instance warm, and logs
// a warning if the API or its DB is unhealthy.
//
// Deploy with the sibling wrangler.toml:  npx wrangler deploy
// (Free plan includes cron triggers. No secrets required.)

const HEALTH_URL = 'https://api.namastepos.in/health';

export default {
  async scheduled(_event, _env, ctx) {
    ctx.waitUntil(ping());
  },
  // Optional: lets you test by visiting the Worker URL in a browser.
  async fetch() {
    const r = await ping();
    return new Response(JSON.stringify(r), {
      headers: { 'content-type': 'application/json' },
    });
  },
};

async function ping() {
  const started = Date.now();
  try {
    const res = await fetch(HEALTH_URL, {
      // Small timeout so a truly-dead API doesn't hang the Worker.
      signal: AbortSignal.timeout(20000),
      cf: { cacheTtl: 0 },
    });
    const ms = Date.now() - started;
    const body = await res.json().catch(() => ({}));
    const ok = res.ok && body.status === 'ok' && body.db === 'ok';
    if (!ok) {
      console.warn(`[keepalive] UNHEALTHY status=${res.status} db=${body.db} in ${ms}ms`);
    } else {
      console.log(`[keepalive] ok in ${ms}ms`);
    }
    return { ok, httpStatus: res.status, db: body.db ?? null, ms };
  } catch (err) {
    console.error(`[keepalive] FAILED after ${Date.now() - started}ms — ${err}`);
    return { ok: false, error: String(err) };
  }
}
