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
  });
  return transporter;
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
      [businessId, userId, template, recipient, subject]
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
      [logRow.id]
    );
    logger.info(`[email] suppressed (no SMTP): ${template} → ${recipient}`);
    return { suppressed: true };
  }

  try {
    const info = await tx.sendMail({
      from: env.SMTP_FROM || 'NamastePOS <hello@namastepos.in>',
      to: recipient,
      subject,
      html: html || undefined,
      text: text || undefined,
    });
    await query(
      `UPDATE email_dispatch_log
          SET status = 'sent', provider_id = $2, sent_at = NOW()
        WHERE id = $1`,
      [logRow.id, info.messageId || null]
    );
    return { sent: true, providerId: info.messageId };
  } catch (err) {
    await query(
      `UPDATE email_dispatch_log
          SET status = 'failed', error_message = $2
        WHERE id = $1`,
      [logRow.id, err.message]
    );
    logger.warn(`[email] failed ${template} → ${recipient}: ${err.message}`);
    return { failed: true, error: err.message };
  }
}

module.exports = { sendMail, ensureTransporter };
