// NamastePOS — Email service (FF-223).
//
// Sends transactional + lifecycle emails via any SMTP provider (SES,
// SendGrid, Postmark, generic Postfix). Configuration lives in env:
//
//   SMTP_HOST          smtp.mailgun.org
//   SMTP_PORT          587
//   SMTP_USER          apikey (or username)
//   SMTP_PASS          <secret>
//   SMTP_FROM          "NamastePOS <hello@namastepos.in>"
//
// When any of the four SMTP_* vars is missing the service becomes a
// no-op logger — it records the intended email to the dispatch log
// with status='suppressed' but doesn't attempt delivery. This keeps
// local dev + CI green without a real mailbox.
//
// `nodemailer` is soft-loaded so the app still boots if the package
// hasn't been installed on this deployment yet.

const { query } = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');

let nodemailer = null;
try {
  // eslint-disable-next-line global-require
  nodemailer = require('nodemailer');
} catch (_) { /* SDK missing → suppressed mode */ }

let transporter = null;
let configured = false;

function ensureTransporter() {
  if (configured) return transporter;
  configured = true;
  if (!nodemailer) return null;
  const {
    SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS,
  } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    // Reliability fix (2026-08-25): every compliance email failed with
    // "Connection timeout" on Render's request path while background
    // (welcome) emails succeeded — the transporter was cached forever and
    // its idle SMTP socket went stale, so the next inline send hung until
    // it timed out. Pooling keeps warm connections and recycles dead ones;
    // explicit timeouts fail fast instead of blocking; and sendMail resets
    // + retries once on a connection error (see below).
    pool: true,
    maxConnections: 3,
    maxMessages: 50,
    connectionTimeout: 10000, // 10s to establish the TCP/TLS connection
    greetingTimeout: 10000, // 10s for the SMTP greeting
    socketTimeout: 20000, // 20s of inactivity before giving up
  });
  return transporter;
}

/** Drop the cached transporter so the next send rebuilds a fresh one. */
function _resetTransporter() {
  try { if (transporter && transporter.close) transporter.close(); } catch (_) { /* ignore */ }
  transporter = null;
  configured = false;
}

/** Heuristic: is this a connection-level failure worth one retry? */
function _isConnError(err) {
  const m = (err && (err.code || err.message) || '').toString().toLowerCase();
  return /timeout|econn|esocket|closed|greeting|etimedout|network/.test(m);
}

/**
 * Sends `template` to `recipient`, records the attempt in
 * email_dispatch_log, and returns the log row.
 *
 * Idempotent when `userId` + `template` are provided — the unique
 * index on (user_id, template) will trip and we surface it as a
 * "already sent" no-op rather than throwing.
 */
async function sendMail({
  template, recipient, subject, html, text,
  businessId = null, userId = null,
}) {
  if (!template || !recipient || !subject || (!html && !text)) {
    throw new Error('emailService.sendMail: template/recipient/subject/body required');
  }

  // Insert placeholder so the DB-level unique index prevents duplicates
  // even if two workers race the scheduler.
  let logRow;
  try {
    const r = await query(
      `INSERT INTO email_dispatch_log
         (business_id, user_id, template, recipient, subject, status)
       VALUES ($1, $2, $3, $4, $5, 'queued') RETURNING *`,
      [businessId, userId, template, recipient, subject],
    );
    logRow = r.rows[0];
  } catch (err) {
    if (err.code === '23505') {
      // Already sent — this is fine, the scheduler will skip on next run.
      return { skipped: true, reason: 'already_sent' };
    }
    throw err;
  }

  const tx = ensureTransporter();
  if (!tx) {
    // SMTP not configured — mark suppressed and return without failing.
    await query(
      `UPDATE email_dispatch_log SET status = 'suppressed', sent_at = NOW()
        WHERE id = $1`,
      [logRow.id],
    );
    logger.info(`[email] suppressed (no SMTP): ${template} → ${recipient}`);
    return { suppressed: true };
  }

  // Preferred path (2026-08-25): Brevo HTTP API over 443. Render's
  // instances block outbound SMTP (25/465/587), so nodemailer to
  // smtp-relay.brevo.com times out — that's why every email failed with
  // "Connection timeout". The HTTP API is never port-blocked. When
  // BREVO_API_KEY is set we use it; otherwise fall back to SMTP (local dev).
  if (process.env.BREVO_API_KEY) {
    try {
      await _sendViaBrevoApi({ recipient, subject, html, text });
      await query(
        'UPDATE email_dispatch_log SET status = \'sent\', sent_at = NOW() WHERE id = $1',
        [logRow.id],
      );
      return { sent: true, via: 'brevo_api' };
    } catch (err) {
      await query(
        'UPDATE email_dispatch_log SET status = \'failed\', error_message = $2 WHERE id = $1',
        [logRow.id, err.message],
      );
      logger.warn(`[email] brevo-api failed ${template} → ${recipient}: ${err.message}`);
      return { failed: true, error: err.message };
    }
  }

  const mail = {
    from: env.SMTP_FROM || 'NamastePOS <hello@namastepos.in>',
    to: recipient,
    subject,
    html: html || undefined,
    text: text || undefined,
  };
  try {
    let info;
    try {
      info = await tx.sendMail(mail);
    } catch (err1) {
      // Reliability fix (2026-08-25): a stale pooled socket surfaces as a
      // connection timeout. Rebuild the transporter once and retry before
      // giving up, so a dead connection doesn't drop a compliance email.
      if (!_isConnError(err1)) throw err1;
      logger.warn(`[email] conn error, rebuilding transporter + retrying: ${err1.message}`);
      _resetTransporter();
      const tx2 = ensureTransporter();
      if (!tx2) throw err1;
      info = await tx2.sendMail(mail);
    }
    await query(
      `UPDATE email_dispatch_log
          SET status = 'sent', provider_id = $2, sent_at = NOW()
        WHERE id = $1`,
      [logRow.id, info.messageId || null],
    );
    return { sent: true, providerId: info.messageId };
  } catch (err) {
    await query(
      `UPDATE email_dispatch_log
          SET status = 'failed', error_message = $2
        WHERE id = $1`,
      [logRow.id, err.message],
    );
    logger.warn(`[email] failed ${template} → ${recipient}: ${err.message}`);
    return { failed: true, error: err.message };
  }
}

/**
 * Send one email through Brevo's transactional HTTP API (v3). Uses the
 * built-in https module (zero deps). Parses "Name <addr>" sender/recipient
 * into Brevo's {name,email} shape. Throws on non-2xx so sendMail records
 * the failure. (2026-08-25 — replaces SMTP on Render where 587 is blocked.)
 */
function _parseAddr(s, fallbackName) {
  const m = /^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/.exec(s || '');
  if (m) return { name: m[1] || fallbackName || undefined, email: m[2] };
  return { name: fallbackName || undefined, email: (s || '').trim() };
}

function _sendViaBrevoApi({ recipient, subject, html, text }) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const from = _parseAddr(env.SMTP_FROM || 'NamastePOS <hello@namastepos.in>', 'NamastePOS');
    const to = _parseAddr(recipient);
    if (!to.email) return reject(new Error('no recipient email'));
    const payload = JSON.stringify({
      sender: { name: from.name || 'NamastePOS', email: from.email },
      to: [{ email: to.email, ...(to.name ? { name: to.name } : {}) }],
      subject,
      ...(html ? { htmlContent: html } : {}),
      ...(text ? { textContent: text } : {}),
    });
    const req = https.request({
      hostname: 'api.brevo.com',
      path: '/v3/smtp/email',
      method: 'POST',
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 15000,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(body);
        reject(new Error(`Brevo API ${res.statusCode}: ${body.slice(0, 200)}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error('Brevo API timeout')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = { sendMail, ensureTransporter };
