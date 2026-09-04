// NamastePOS — Onboarding email sequence (FF-223).
//
// D0 fires immediately after registration (see authController).
// D3 + D7 fire from a background scheduler that runs every hour and
// looks for owners whose registration age has crossed the threshold
// AND who haven't already received the template.
//
// Every template returns { subject, html, text } — plain-text is
// included so ISPs (Gmail spam filter especially) treat the message
// as legit and not HTML-only marketing bait.
//
// Copy is written in Shivhari's voice: warm, direct, action-oriented,
// India-first (Rupee symbol, cricket-hour references, etc). Change
// once we have a proper brand voice guide.

const { query } = require('../config/db');
const email = require('./emailService');
const logger = require('../config/logger');

const env = require('../config/env');
// Hardcode-audit fix (2026-08-24): read the centralised env config; the
// prod-domain fallback is kept ONLY as a last resort for release builds.
const APP_URL = env.APP_URL || 'https://namastepos.in';

// ── Templates ──────────────────────────────────────────────────────────
function tplD0({ name }) {
  return {
    subject: 'Welcome to NamastePOS — your restaurant, on autopilot',
    text:
`Hi ${name || 'there'},

Thanks for signing up for NamastePOS. You've got everything you need to run your restaurant: POS, KOT, table plan, GST invoicing, WhatsApp updates, and a customer dashboard — all in one app.

Three things to try in the next 5 minutes:
  1. Add your first 5 menu items → ${APP_URL}/menu
  2. Print a QR code and stick it on a table → ${APP_URL}/qr-codes
  3. Open the mobile app and place a test order

Reply to this email if you get stuck — a human reads every one.

— Shivhari
Founder, NamastePOS`,
    html: `
<!doctype html>
<html><body style="font-family:system-ui,sans-serif;color:#111;max-width:560px;margin:0 auto;padding:24px">
  <h1 style="color:#FF6B35;margin:0 0 12px">Welcome to NamastePOS 🎉</h1>
  <p>Hi ${name || 'there'},</p>
  <p>Thanks for signing up. You've got the full kit: POS, KOT, table plan, GST invoicing, WhatsApp updates, a customer dashboard.</p>
  <p><strong>Try in the next 5 minutes:</strong></p>
  <ol>
    <li>Add your first 5 menu items → <a href="${APP_URL}/menu">${APP_URL}/menu</a></li>
    <li>Print a QR code and stick it on a table → <a href="${APP_URL}/qr-codes">${APP_URL}/qr-codes</a></li>
    <li>Open the mobile app and place a test order</li>
  </ol>
  <p>Reply to this email if you get stuck — a human reads every one.</p>
  <p>— Shivhari<br/><span style="color:#666">Founder, NamastePOS</span></p>
</body></html>`.trim(),
  };
}

function tplD3({ name }) {
  return {
    subject: 'How is your first few days on NamastePOS?',
    text:
`Hi ${name || 'there'},

Three days in — how's it going?

Common questions from new owners:
  • Bluetooth thermal printer not connecting? → Settings → Printers → Scan
  • Zomato/Swiggy orders not showing? → Marketplace → Online Orders addon
  • Staff can't sign in? → Staff → Add captain/cashier → set 4-digit PIN

Book 15 minutes with me and we'll get you set up: ${APP_URL}/help

— Shivhari
Founder, NamastePOS`,
    html: `
<!doctype html>
<html><body style="font-family:system-ui,sans-serif;color:#111;max-width:560px;margin:0 auto;padding:24px">
  <h1 style="color:#FF6B35;margin:0 0 12px">How's it going?</h1>
  <p>Hi ${name || 'there'},</p>
  <p>Three days in — how are the first orders going?</p>
  <p><strong>Common questions from new owners:</strong></p>
  <ul>
    <li>Bluetooth thermal printer not connecting? → Settings → Printers → Scan</li>
    <li>Zomato/Swiggy orders not showing? → Marketplace → Online Orders addon</li>
    <li>Staff can't sign in? → Staff → Add captain/cashier → set 4-digit PIN</li>
  </ul>
  <p>Book 15 minutes with me and I'll get you set up: <a href="${APP_URL}/help">${APP_URL}/help</a></p>
  <p>— Shivhari<br/><span style="color:#666">Founder, NamastePOS</span></p>
</body></html>`.trim(),
  };
}

function tplD7({ name }) {
  return {
    subject: 'One week with NamastePOS — worth a coffee chat?',
    text:
`Hi ${name || 'there'},

You've been on NamastePOS for a week. If it's saving you time, tell me one thing that clicked. If it's not, tell me one thing that's broken — I'll fix it personally.

Reply direct. Founder's inbox.

— Shivhari`,
    html: `
<!doctype html>
<html><body style="font-family:system-ui,sans-serif;color:#111;max-width:560px;margin:0 auto;padding:24px">
  <p>Hi ${name || 'there'},</p>
  <p>You've been on NamastePOS for a week. Two questions:</p>
  <ol>
    <li>What clicked? (One thing that saved you time.)</li>
    <li>What's broken? (One thing that annoyed you.)</li>
  </ol>
  <p>Reply direct. Founder's inbox.</p>
  <p>— Shivhari</p>
</body></html>`.trim(),
  };
}

// ── Public API ─────────────────────────────────────────────────────────

async function sendWelcome({ userId, businessId, email: recipient, name }) {
  const tpl = tplD0({ name });
  return email.sendMail({
    template: 'onboarding_d0',
    recipient,
    subject: tpl.subject,
    html: tpl.html,
    text: tpl.text,
    userId,
    businessId,
  });
}

async function runScheduler() {
  // Runs D3 + D7 in one pass.
  await dispatchStage('onboarding_d3', 3, tplD3);
  await dispatchStage('onboarding_d7', 7, tplD7);
}

async function dispatchStage(template, days, tplFn) {
  // Find users who registered exactly `days` ago (± 12h window) and
  // haven't been sent this template yet. Owner-only.
  const r = await query(
    `SELECT u.id AS user_id, u.email, u.display_name AS name,
            bu.business_id
       FROM users u
       JOIN business_users bu ON bu.user_id = u.id AND bu.role = 'business_owner'
       LEFT JOIN email_dispatch_log l
         ON l.user_id = u.id AND l.template = $1
      WHERE l.id IS NULL
        AND u.created_at BETWEEN NOW() - INTERVAL '${days + 1} days'
                             AND NOW() - INTERVAL '${days} days'
        AND u.email IS NOT NULL`,
    [template],
  );
  if (r.rowCount === 0) return;
  logger.info(`[onboarding] ${template}: ${r.rowCount} candidate(s)`);
  for (const row of r.rows) {
    try {
      const tpl = tplFn({ name: row.name });
      await email.sendMail({
        template,
        recipient: row.email,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
        userId: row.user_id,
        businessId: row.business_id,
      });
    } catch (e) {
      logger.warn(`[onboarding] ${template} failed for ${row.email}: ${e.message}`);
    }
  }
}

/**
 * Start the periodic scheduler. Runs immediately, then every hour.
 * Idempotent — calling twice returns the same timer handle.
 */
let _timer = null;
function startScheduler() {
  if (_timer) return _timer;
  const HOUR = 60 * 60 * 1000;
  const tick = () => runScheduler().catch((e) => logger.error(`[onboarding] scheduler tick failed: ${e.message}`));
  // Slight delay on first run so the app finishes booting first.
  setTimeout(tick, 30 * 1000);
  _timer = setInterval(tick, HOUR);
  return _timer;
}

function stopScheduler() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = {
  sendWelcome,
  runScheduler,
  startScheduler,
  stopScheduler,
  // exposed for testing
  __tplD0: tplD0,
  __tplD3: tplD3,
  __tplD7: tplD7,
};
