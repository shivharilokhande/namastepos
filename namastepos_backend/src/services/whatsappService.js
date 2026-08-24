// WhatsApp ordering + marketing (Sprint 6 / FF-702, FF-1004)
//
// Provider-agnostic: works with Twilio's WhatsApp Business API by default,
// pluggable via env. Inbound webhook normalises into wa_messages + wa_threads;
// the conversation state machine ('idle' → 'menu' → 'cart' → 'confirming')
// drives reply text.

const { query, withTransaction } = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');

async function _appendInbound(businessId, phone, body, providerMsgId, name) {
  return withTransaction(async (client) => {
    const t = await client.query(
      `INSERT INTO wa_threads (business_id, customer_phone, customer_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (business_id, customer_phone) DO UPDATE
         SET customer_name = COALESCE(wa_threads.customer_name, EXCLUDED.customer_name),
             last_message_at = NOW()
       RETURNING *`,
      [businessId, phone, name || null]
    );
    await client.query(
      `INSERT INTO wa_messages
         (business_id, thread_id, direction, body, provider_msg_id)
       VALUES ($1, $2, 'in', $3, $4)`,
      [businessId, t.rows[0].id, body, providerMsgId || null]
    );
    return t.rows[0];
  });
}

async function _sendOutbound(businessId, phone, body) {
  // Real send (Twilio):
  if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_WA_FROM) {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
    const params = new URLSearchParams({
      From: `whatsapp:${env.TWILIO_WA_FROM}`,
      To: `whatsapp:${phone}`,
      Body: body,
    });
    const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const fetch = global.fetch || require('node-fetch');
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!r.ok) {
      const text = await r.text();
      logger.warn(`WA send failed (${r.status}): ${text}`);
      return null;
    }
    const j = await r.json();
    return j.sid;
  }
  logger.info(`[WA mock] → ${phone}: ${body}`);
  return null;
}

// ── Public: ingest inbound, drive conversation ────────────────────────
async function handleInbound(businessId, { phone, body, providerMsgId, name }) {
  const thread = await _appendInbound(businessId, phone, body, providerMsgId, name);
  const reply = await _drive(businessId, thread, body.trim());
  if (reply) {
    const sid = await _sendOutbound(businessId, phone, reply);
    await query(
      `INSERT INTO wa_messages
         (business_id, thread_id, direction, body, provider_msg_id)
       VALUES ($1, $2, 'out', $3, $4)`,
      [businessId, thread.id, reply, sid]
    );
  }
  return { acknowledged: true };
}

async function _drive(businessId, thread, message) {
  const lower = message.toLowerCase();

  // FF-1002 — if the message is JUST a number 0-10 and there's a
  // pending NPS ping for this phone, treat it as feedback. Runs
  // BEFORE the state machine so a customer replying "9" after a
  // meal isn't misread as "9 orders of item #9".
  if (/^([0-9]|10)\s*$/.test(message.trim())) {
    const nps = require('./npsService');
    const reply = await nps.handleReply({
      businessId, phone: thread.customer_phone, body: message,
    });
    if (reply) return reply;
  }

  if (thread.state === 'idle' || ['hi', 'hello', 'menu', 'order'].includes(lower)) {
    // Send abbreviated menu
    const items = await query(
      `SELECT name, price, category FROM menu_items
        WHERE business_id = $1 AND is_active = TRUE
        ORDER BY display_order, name LIMIT 12`,
      [businessId]
    );
    await query(`UPDATE wa_threads SET state = 'menu' WHERE id = $1`, [thread.id]);
    const lines = items.rows.map((i, idx) => `${idx + 1}. ${i.name} — ₹${i.price}`);
    return `Welcome! Here's our menu — reply with item numbers:\n\n${lines.join('\n')}\n\nReply "done" when finished.`;
  }
  if (thread.state === 'menu') {
    if (lower === 'done') {
      await query(`UPDATE wa_threads SET state = 'confirming' WHERE id = $1`, [thread.id]);
      return `Got it! Please confirm by replying "yes" — or "cancel" to start over.`;
    }
    return `Add items by number — e.g. "1, 3, 5". Or "done" to finish.`;
  }
  if (thread.state === 'confirming') {
    if (lower === 'yes') {
      await query(`UPDATE wa_threads SET state = 'idle', draft_cart = NULL WHERE id = $1`, [thread.id]);
      return `Your order has been placed. We'll WhatsApp you when it's ready.`;
    }
    await query(`UPDATE wa_threads SET state = 'idle' WHERE id = $1`, [thread.id]);
    return `Cancelled. Reply "menu" to start over.`;
  }
  return null;
}

// ── Campaigns ────────────────────────────────────────────────────────────
async function createCampaign(businessId, body, createdBy) {
  const { name, templateBody, audienceFilter, scheduledAt } = body;
  // Count audience
  const cnt = await query(
    `SELECT COUNT(*)::int AS n FROM customers
      WHERE business_id = $1 AND marketing_optin = TRUE`,
    [businessId]
  );
  const r = await query(
    `INSERT INTO wa_campaigns
       (business_id, name, template_body, audience_filter, scheduled_at,
        recipient_count, created_by_user_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'scheduled') RETURNING *`,
    [businessId, name, templateBody,
     audienceFilter ? JSON.stringify(audienceFilter) : null,
     scheduledAt || new Date(), cnt.rows[0].n, createdBy || null]
  );
  return r.rows[0];
}

async function listCampaigns(businessId) {
  const r = await query(
    `SELECT * FROM wa_campaigns WHERE business_id = $1
      ORDER BY created_at DESC LIMIT 50`,
    [businessId]
  );
  return r.rows;
}

async function runCampaign(businessId, campaignId) {
  const c = await query(
    `UPDATE wa_campaigns SET status = 'running'
      WHERE business_id = $1 AND id = $2 RETURNING *`,
    [businessId, campaignId]
  );
  if (c.rowCount === 0) return null;
  const audience = await query(
    `SELECT phone, name FROM customers
      WHERE business_id = $1 AND marketing_optin = TRUE
      LIMIT 1000`,
    [businessId]
  );
  let sent = 0;
  for (const cust of audience.rows) {
    const personalised = c.rows[0].template_body.replace(/\{name\}/g, cust.name || 'there');
    const sid = await _sendOutbound(businessId, cust.phone, personalised);
    if (sid !== null) sent += 1;
  }
  await query(
    `UPDATE wa_campaigns SET status = 'done', sent_count = $1
      WHERE id = $2`,
    [sent, campaignId]
  );
  return { sent };
}

/**
 * FF-248 — public helper for one-off outbound sends (anomaly alerts,
 * lifecycle emails' WA companion, etc.). Doesn't touch wa_threads /
 * wa_messages because these are system-generated pings, not
 * customer conversations. Soft no-op if Twilio isn't configured.
 */
async function sendRaw({ to, body }) {
  if (!to || !body) return null;
  const normalized = to.startsWith('+') ? to : `+91${to.replace(/^0/, '')}`;
  return _sendOutbound(null, normalized, body);
}

module.exports = {
  handleInbound, _sendOutbound, sendRaw,
  createCampaign, listCampaigns, runCampaign,
};
