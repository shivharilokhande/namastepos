// NamastePOS backend — support / ticketing (X7).
//
// Tenants (or admins on their behalf) raise tickets; support replies from the
// admin console. Kept deliberately small: a ticket + a thread of messages.

const { query } = require('../config/db');
const { NotFound, BadRequest } = require('../utils/errors');

const STATUSES = ['open', 'pending', 'resolved', 'closed'];
const PRIORITIES = ['low', 'normal', 'high', 'critical'];

function serializeTicket(t) {
  return {
    id: t.id,
    businessId: t.business_id,
    businessName: t.business_name,
    subject: t.subject,
    status: t.status,
    priority: t.priority,
    createdByAdmin: t.created_by_admin,
    lastReplyAt: t.last_reply_at,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    messageCount: t.message_count != null ? parseInt(t.message_count, 10) : undefined,
  };
}

function serializeMessage(m) {
  return {
    id: m.id,
    ticketId: m.ticket_id,
    authorType: m.author_type,
    authorEmail: m.author_email,
    body: m.body,
    createdAt: m.created_at,
  };
}

// Create a ticket. `byAdmin` distinguishes admin-raised (support logging a
// call) from tenant-raised.
async function createTicket({ businessId, subject, priority = 'normal', body,
  authorUserId = null, authorEmail = null, byAdmin = false }) {
  if (!businessId || !subject || !body) throw new BadRequest('businessId, subject and body are required');
  if (!PRIORITIES.includes(priority)) priority = 'normal';
  const t = await query(
    `INSERT INTO support_tickets
       (business_id, subject, priority, created_by_user_id, created_by_admin, last_reply_at)
     VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING *`,
    [businessId, subject.slice(0, 200), priority, authorUserId, byAdmin],
  );
  const ticket = t.rows[0];
  await query(
    `INSERT INTO support_ticket_messages (ticket_id, author_type, author_id, author_email, body)
     VALUES ($1, $2, $3, $4, $5)`,
    [ticket.id, byAdmin ? 'admin' : 'tenant', authorUserId, authorEmail, body],
  );
  return serializeTicket(ticket);
}

// Admin list with optional status filter + message counts + business name.
// NP-143 (2026-09-03): the list was unbounded (every ticket, every page load)
// and counted messages via a correlated subquery per row. Now paginated
// (limit default 50, max 200) with `total` from COUNT(*) OVER(), and the
// message counts come from ONE grouped join over support_ticket_messages.
// Returns { tickets, total } — callers keep the `tickets` array shape.
async function listTickets({ status, businessId, limit = 50, offset = 0 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  const where = ['1=1']; const vals = []; let i = 1;
  if (status && STATUSES.includes(status)) { where.push(`t.status = $${i++}`); vals.push(status); }
  if (businessId) { where.push(`t.business_id = $${i++}`); vals.push(businessId); }
  vals.push(lim, off);
  const r = await query(
    `SELECT t.*, b.name AS business_name,
            COALESCE(mc.message_count, 0) AS message_count,
            COUNT(*) OVER() AS total_count
       FROM support_tickets t
       JOIN businesses b ON b.id = t.business_id
  LEFT JOIN (SELECT ticket_id, COUNT(*) AS message_count
               FROM support_ticket_messages
              GROUP BY ticket_id) mc ON mc.ticket_id = t.id
      WHERE ${where.join(' AND ')}
      ORDER BY (t.status IN ('open','pending')) DESC,
               CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
               t.last_reply_at DESC NULLS LAST
      LIMIT $${i++} OFFSET $${i++}`,
    vals,
  );
  const total = r.rows.length > 0 ? parseInt(r.rows[0].total_count, 10) : 0;
  return { tickets: r.rows.map(serializeTicket), total };
}

async function getTicket(id) {
  const t = await query(`SELECT t.*, b.name AS business_name FROM support_tickets t
       JOIN businesses b ON b.id = t.business_id WHERE t.id = $1`, [id]);
  if (t.rowCount === 0) throw new NotFound('Ticket not found');
  const msgs = await query('SELECT * FROM support_ticket_messages WHERE ticket_id = $1 ORDER BY created_at ASC', [id]);
  return { ...serializeTicket(t.rows[0]), messages: msgs.rows.map(serializeMessage) };
}

async function addMessage(id, { body, authorType, authorId = null, authorEmail = null }) {
  if (!body) throw new BadRequest('body is required');
  const t = await query('SELECT id FROM support_tickets WHERE id = $1', [id]);
  if (t.rowCount === 0) throw new NotFound('Ticket not found');
  await query(
    `INSERT INTO support_ticket_messages (ticket_id, author_type, author_id, author_email, body)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, authorType === 'admin' ? 'admin' : 'tenant', authorId, authorEmail, body],
  );
  // An admin reply moves an open ticket to 'pending' (awaiting tenant);
  // a tenant reply re-opens it.
  const newStatus = authorType === 'admin' ? 'pending' : 'open';
  await query(
    `UPDATE support_tickets SET last_reply_at = NOW(), updated_at = NOW(),
            status = CASE WHEN status IN ('resolved','closed') AND $2 = 'open' THEN 'open'::support_ticket_status
                          WHEN status NOT IN ('resolved','closed') THEN $2::support_ticket_status
                          ELSE status END
      WHERE id = $1`,
    [id, newStatus],
  );
  return getTicket(id);
}

async function setStatus(id, status) {
  if (!STATUSES.includes(status)) throw new BadRequest('Invalid status');
  const r = await query(`UPDATE support_tickets SET status = $2::support_ticket_status, updated_at = NOW()
      WHERE id = $1 RETURNING *`, [id, status]);
  if (r.rowCount === 0) throw new NotFound('Ticket not found');
  return serializeTicket(r.rows[0]);
}

module.exports = { createTicket, listTickets, getTicket, addMessage, setStatus, STATUSES, PRIORITIES };
