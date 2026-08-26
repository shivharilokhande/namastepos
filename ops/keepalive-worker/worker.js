// NamastePOS keep-alive — Cloudflare Worker (Cron Trigger).
//
// Render's free web service spins down after ~15 min idle, so the first
// request after a lull takes 60–90s (looks like the app "crashed"). This
// Worker pings /health every 5 minutes to keep the instance warm, and logs
// a warning if the API or its DB is unhealthy.
//
// Deploy with the sibling wrangler.toml:  npx wrangler deploy
// (Free plan includes cron triggers. No secrets required.)

// /v1/health returns {status, service, db, ...} so this ping both keeps
// Render warm AND surfaces DB health. (/health is a lighter liveness route
// without the db field.)
const HEALTH_URL = 'https://api.namastepos.in/v1/health';

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
    // Keep-alive success = we got a real HTTP response (Render is awake).
    // Reaching the origin at all is what prevents the cold-start.
    const alive = res.ok;
    // DB health is a secondary signal parsed from the body (parse defensively
    // in case the body is ever non-JSON, so a quirk never masks "alive").
    const text = await res.text().catch(() => '');
    let db = null;
    try { db = JSON.parse(text).db ?? null; } catch { /* non-JSON body */ }

    if (!alive) {
      console.warn(`[keepalive] API not alive — status=${res.status} in ${ms}ms`);
    } else if (db && db !== 'ok') {
      console.warn(`[keepalive] API up but DB=${db} in ${ms}ms`);
    } else {
      console.log(`[keepalive] ok (db=${db ?? 'n/a'}) in ${ms}ms`);
    }
    return { ok: alive, httpStatus: res.status, db, ms, sample: text.slice(0, 160) };
  } catch (err) {
    console.error(`[keepalive] FAILED after ${Date.now() - started}ms — ${err}`);
    return { ok: false, error: String(err) };
  }
}
