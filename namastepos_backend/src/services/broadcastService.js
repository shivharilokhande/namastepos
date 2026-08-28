// NamastePOS backend — in-console tenant broadcast (X4).
//
// Lets an admin email a segment of tenants (announcements, upsell, win-back)
// via the existing Brevo transport. Recipients come from businesses.email.
// A `preview` returns the audience count + a sample without sending.

const { query } = require('../config/db');
const email = require('./emailService');
const logger = require('../config/logger');
const { BadRequest } = require('../utils/errors');

// Resolve recipients for a segment. Segments:
//   all | active | trialing | past_due | trial_ending | plan:<tier>
async function resolveRecipients(segment = 'all') {
  const base = `SELECT b.id, b.name, b.email
                  FROM businesses b
             LEFT JOIN subscriptions s ON s.business_id = b.id
             LEFT JOIN plans p ON p.id = s.plan_id
                 WHERE b.deleted_at IS NULL AND b.email IS NOT NULL AND b.email <> ''`;
  let sql = base; const vals = [];
  if (segment === 'active' || segment === 'trialing' || segment === 'past_due') {
    sql += ` AND s.status = $1`; vals.push(segment);
  } else if (segment === 'trial_ending') {
    sql += ` AND s.status = 'trialing' AND s.trial_ends_at IS NOT NULL
             AND s.trial_ends_at BETWEEN NOW() AND NOW() + INTERVAL '7 days'`;
  } else if (segment && segment.startsWith('plan:')) {
    sql += ` AND p.tier = $1`; vals.push(segment.slice(5));
  } else if (segment !== 'all') {
    throw new BadRequest(`Unknown segment: ${segment}`);
  }
  sql += ` ORDER BY b.created_at DESC`;
  const r = await query(sql, vals);
  // Dedupe by email (a person can own multiple businesses).
  const seen = new Set(); const out = [];
  for (const row of r.rows) {
    const e = row.email.toLowerCase();
    if (seen.has(e)) continue;
    seen.add(e); out.push(row);
  }
  return out;
}

async function preview(segment) {
  const rows = await resolveRecipients(segment);
  return { count: rows.length, sample: rows.slice(0, 10).map((r) => ({ name: r.name, email: r.email })) };
}

async function send({ segment, subject, body, actorEmail }) {
  if (!subject || !body) throw new BadRequest('subject and body are required');
  const rows = await resolveRecipients(segment);
  const html = `<div style="font-family:Inter,system-ui,sans-serif;line-height:1.55">${
    String(body).split('\n').map((l) => `<p>${l}</p>`).join('')
  }</div>`;
  let sent = 0; let failed = 0;
  // Small audiences — send sequentially and swallow per-recipient failures.
  for (const r of rows) {
    try {
      await email.sendMail({
        template: 'broadcast', recipient: r.email,
        subject, html, text: body, businessId: r.id,
      });
      sent += 1;
    } catch (err) {
      failed += 1;
      logger.warn(`broadcast: failed to ${r.email}: ${err.message}`);
    }
  }
  logger.info(`broadcast by ${actorEmail || 'admin'} segment=${segment} sent=${sent} failed=${failed}`);
  return { segment, recipients: rows.length, sent, failed };
}

module.exports = { resolveRecipients, preview, send };
