// NamastePOS backend - DPDP compliance service
//
// Single point of entry for the four compliance pillars:
//   1. recordConsent / withdrawConsent / consentHistory
//   2. file/list/handle data-subject requests (access/correction/erasure/portability)
//   3. file/list/handle grievance complaints
//   4. log/report breach incidents
//
// All routes that touch these must go through this service so the
// `created_at` / `source` / `ip_address` evidence trail is captured
// the same way every time.

const { query, withTransaction } = require('../config/db');
const { BadRequest, NotFound } = require('../utils/errors');
const crypto = require('crypto');

// Known consent keys. Anything outside this list is rejected so a
// typo doesn't produce orphan consent records that the dashboard
// won't display.
const CONSENT_KEYS = new Set([
  'privacy_policy',
  'terms_of_service',
  'marketing_email',
  'marketing_whatsapp',
  'marketing_sms',
  'cookies_analytics',
  'cookies_marketing',
  'data_sharing_payment',
]);

// ── Compliance notification emails (founder bug #15, 2026-08-25) ────
// WHY: DPDP Act 2023 puts an acknowledgement duty on the data fiduciary —
// grievances and data-subject requests must be acknowledged to the data
// principal (we publish ack_due_at / sla deadlines), and the business
// owner has to actually LEARN a complaint exists to act on it in time.
// Until now these rows only landed in Postgres and nobody was told.
// All sends are best-effort: emailService.sendMail() already no-ops when
// SMTP isn't configured, and we additionally try/catch every call so an
// email hiccup can never fail the API insert that already succeeded.
// NOTE: userId is deliberately passed as null to sendMail — the
// email_dispatch_log unique index on (user_id, template) is a one-shot
// dedupe for lifecycle emails, and a user may legitimately file more
// than one grievance/DSR.

async function _businessOwnerEmail(businessId) {
  if (!businessId) return null;
  const r = await query(
    `SELECT email FROM businesses WHERE id = $1 LIMIT 1`,
    [businessId]
  );
  return r.rows[0]?.email || null;
}

function _fmtDue(d) {
  if (!d) return 'n/a';
  try {
    return new Date(d).toLocaleString('en-IN', {
      dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata',
    });
  } catch (_) { return String(d); }
}

/**
 * Best-effort pair of emails after a grievance/DSR insert:
 *   (a) notify the business owner (businesses.email when businessId is
 *       present; falls back to SMTP_FROM so platform-level filings still
 *       reach the grievance inbox; skipped when neither exists)
 *   (b) acknowledgement to the complainant/requester when we have an email
 * Never throws.
 */
// Fire-and-forget wrapper (2026-08-25 fix): the privacy screen hung because
// callers AWAITED the two SMTP sends below — a slow/unreachable recipient
// domain (Brevo retrying) blocked the whole HTTP response until the client
// timed out. DPDP only requires the request be RECORDED synchronously; the
// ack/notify emails are best-effort, so we detach them from the request
// lifecycle. Callers invoke this (non-awaited) and return immediately.
function _dispatchComplianceEmails(opts) {
  // Deliberately not awaited by callers; swallow any rejection here too so
  // an unhandledRejection can never crash the process.
  _sendComplianceEmails(opts).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn(`[compliance] email dispatch failed (${opts.kind} ${opts.refId}): ${err.message}`);
  });
}

async function _sendComplianceEmails({
  kind,            // 'grievance' | 'request'
  refId,
  businessId = null,
  principalEmail = null,
  summaryHtml = '',
  ackDueAt = null,
  resolveDueAt = null,
}) {
  const { sendMail } = require('./emailService');
  const noun = kind === 'grievance' ? 'grievance' : 'request';

  // (a) Owner notification
  try {
    const ownerEmail = (await _businessOwnerEmail(businessId))
      || require('../config/env').SMTP_FROM
      || process.env.SMTP_FROM
      || null;
    if (ownerEmail) {
      await sendMail({
        template: `compliance_${kind}_owner_notify`,
        recipient: ownerEmail,
        businessId,
        userId: null,
        subject: `New ${noun} filed (ref ${refId}) — action required`,
        html: `<p>A new ${noun} has been filed on NamastePOS (ref <b>${refId}</b>).</p>`
          + summaryHtml
          + `<p>Acknowledge by: <b>${_fmtDue(ackDueAt)}</b><br/>`
          + `Resolve by: <b>${_fmtDue(resolveDueAt)}</b></p>`
          + `<p>Please handle it from the compliance section of your dashboard.</p>`,
      });
    }
  } catch (err) {
    console.warn(`[compliance] owner notify email failed (${kind} ${refId}): ${err.message}`);
  }

  // (b) Acknowledgement to the data principal
  try {
    if (principalEmail) {
      await sendMail({
        template: `compliance_${kind}_ack`,
        recipient: principalEmail,
        businessId,
        userId: null,
        subject: `We received your ${noun} (ref ${refId})`,
        html: `<p>Thank you — we have received your ${noun} (reference <b>${refId}</b>).</p>`
          + `<p>You will get an acknowledgement by <b>${_fmtDue(ackDueAt)}</b>`
          + (resolveDueAt
              ? ` and a resolution by <b>${_fmtDue(resolveDueAt)}</b>.` : '.')
          + `</p><p>This mailbox records your reference for the DPDP grievance process; `
          + `please quote ref ${refId} in any follow-up.</p>`,
      });
    }
  } catch (err) {
    console.warn(`[compliance] ack email failed (${kind} ${refId}): ${err.message}`);
  }
}

const REQUEST_TYPES   = new Set(['access', 'correction', 'erasure', 'portability', 'withdraw_consent']);
const REQUEST_STATUS  = new Set(['pending', 'in_review', 'completed', 'rejected', 'partial']);
const GRIEVANCE_STATUS = new Set(['received', 'acknowledged', 'resolved', 'rejected', 'escalated']);
const BREACH_STATUS = new Set(['detected', 'triaging', 'contained', 'notified', 'closed']);

// ────────────────────────────────────────────────────────────────────
// 1. Consent
// ────────────────────────────────────────────────────────────────────

/**
 * Record a consent grant or withdrawal. Append-only — we never UPDATE
 * an existing row, we insert a new row whenever the state changes.
 *
 * Required: consentKey + granted + source + at least one of
 * {userId, guestPhone, sessionId}.
 */
async function recordConsent({
  userId = null,
  businessId = null,
  guestPhone = null,
  sessionId = null,
  consentKey,
  granted,
  policyVersion = null,
  source,
  ipAddress = null,
  userAgent = null,
  context = {},
}) {
  if (!CONSENT_KEYS.has(consentKey)) {
    throw new BadRequest(`Unknown consent key "${consentKey}"`);
  }
  if (typeof granted !== 'boolean') {
    throw new BadRequest('granted must be true or false');
  }
  if (!source) {
    throw new BadRequest('source is required (mobile_app/dashboard/qr_menu/cookie_banner/api)');
  }
  if (!userId && !guestPhone && !sessionId) {
    throw new BadRequest('Provide at least one of userId, guestPhone, sessionId');
  }

  const r = await query(
    `INSERT INTO consent_events
       (user_id, business_id, guest_phone, session_id,
        consent_key, granted, policy_version, source,
        ip_address, user_agent, context)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id, created_at`,
    [userId, businessId, guestPhone, sessionId,
     consentKey, granted, policyVersion, source,
     ipAddress, userAgent, JSON.stringify(context || {})]
  );
  return { id: r.rows[0].id, createdAt: r.rows[0].created_at };
}

/** List the latest state of every consent key for a principal. */
async function currentConsents({ userId = null, guestPhone = null, sessionId = null }) {
  if (!userId && !guestPhone && !sessionId) {
    throw new BadRequest('Provide one of userId, guestPhone, sessionId');
  }
  // DISTINCT ON returns the most-recent row per (consent_key) for
  // the supplied principal.
  const params = [];
  const where = [];
  if (userId)     { params.push(userId);     where.push(`user_id = $${params.length}`); }
  if (guestPhone) { params.push(guestPhone); where.push(`guest_phone = $${params.length}`); }
  if (sessionId)  { params.push(sessionId);  where.push(`session_id = $${params.length}`); }

  const r = await query(
    `SELECT DISTINCT ON (consent_key)
            consent_key, granted, policy_version, source, created_at
       FROM consent_events
      WHERE ${where.join(' OR ')}
      ORDER BY consent_key, created_at DESC`,
    params
  );
  return r.rows.map(row => ({
    consentKey:    row.consent_key,
    granted:       row.granted,
    policyVersion: row.policy_version,
    source:        row.source,
    recordedAt:    row.created_at,
  }));
}

/** Full audit trail for one principal. Used by /me/export and admin tools. */
async function consentHistory({ userId = null, guestPhone = null, sessionId = null, limit = 500 }) {
  if (!userId && !guestPhone && !sessionId) {
    throw new BadRequest('Provide one of userId, guestPhone, sessionId');
  }
  const params = [];
  const where = [];
  if (userId)     { params.push(userId);     where.push(`user_id = $${params.length}`); }
  if (guestPhone) { params.push(guestPhone); where.push(`guest_phone = $${params.length}`); }
  if (sessionId)  { params.push(sessionId);  where.push(`session_id = $${params.length}`); }
  params.push(Math.min(Math.max(limit, 1), 5000));

  const r = await query(
    `SELECT id, consent_key, granted, policy_version, source,
            ip_address, user_agent, context, created_at
       FROM consent_events
      WHERE ${where.join(' OR ')}
      ORDER BY created_at DESC
      LIMIT $${params.length}`,
    params
  );
  return r.rows.map(row => ({
    id:            row.id,
    consentKey:    row.consent_key,
    granted:       row.granted,
    policyVersion: row.policy_version,
    source:        row.source,
    ipAddress:     row.ip_address,
    userAgent:     row.user_agent,
    context:       row.context,
    recordedAt:    row.created_at,
  }));
}

// ────────────────────────────────────────────────────────────────────
// 2. Data subject requests (DPDP rights)
// ────────────────────────────────────────────────────────────────────

async function fileDataSubjectRequest({
  userId = null,
  businessId = null,
  guestPhone = null,
  contactEmail = null,
  requestType,
  details = {},
  source = 'self_service',
}) {
  if (!REQUEST_TYPES.has(requestType)) {
    throw new BadRequest(`Unknown requestType "${requestType}"`);
  }
  if (!userId && !guestPhone && !contactEmail) {
    throw new BadRequest('Provide a principal identifier (userId / guestPhone / contactEmail)');
  }
  const r = await query(
    `INSERT INTO data_subject_requests
       (user_id, business_id, guest_phone, contact_email,
        request_type, details, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, status, sla_due_at, created_at`,
    [userId, businessId, guestPhone, contactEmail,
     requestType, JSON.stringify(details || {}), source]
  );
  await query(
    `INSERT INTO data_subject_request_events (request_id, to_status, note)
     VALUES ($1, 'pending', 'Request filed')`,
    [r.rows[0].id]
  );
  // Founder bug #15 (2026-08-25): DPDP acknowledgement duty — notify the
  // owner + ack the requester. Best-effort, never fails the insert above.
  _dispatchComplianceEmails({
    kind: 'request',
    refId: r.rows[0].id,
    businessId,
    principalEmail: contactEmail,
    summaryHtml: `<p>Type: <b>${requestType}</b></p>`,
    ackDueAt: r.rows[0].sla_due_at,
    resolveDueAt: r.rows[0].sla_due_at,
  });
  return {
    id:        r.rows[0].id,
    status:    r.rows[0].status,
    slaDueAt:  r.rows[0].sla_due_at,
    createdAt: r.rows[0].created_at,
  };
}

async function listDataSubjectRequests({ userId = null, status = null, limit = 100 } = {}) {
  const params = [];
  const where = [];
  if (userId) { params.push(userId); where.push(`user_id = $${params.length}`); }
  if (status) {
    if (!REQUEST_STATUS.has(status)) throw new BadRequest(`Unknown status "${status}"`);
    params.push(status);
    where.push(`status = $${params.length}`);
  }
  params.push(Math.min(Math.max(limit, 1), 500));

  const r = await query(
    `SELECT id, user_id, business_id, guest_phone, contact_email,
            request_type, status, details, source,
            sla_due_at, responded_at, closed_at,
            handled_by, proof_hash, created_at, updated_at
       FROM data_subject_requests
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY created_at DESC
      LIMIT $${params.length}`,
    params
  );
  return r.rows.map(serializeDSR);
}

async function updateDataSubjectRequest({ id, status, note = null, handledBy = null, proofHash = null }) {
  if (!REQUEST_STATUS.has(status)) throw new BadRequest(`Unknown status "${status}"`);

  return withTransaction(async (client) => {
    const existing = await client.query(
      `SELECT status FROM data_subject_requests WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!existing.rows[0]) throw new NotFound('Data subject request not found');
    const fromStatus = existing.rows[0].status;

    const respondedAt = ['in_review','completed','rejected','partial'].includes(status) ? 'now()' : 'responded_at';
    const closedAt    = ['completed','rejected'].includes(status) ? 'now()' : 'closed_at';

    const r = await client.query(
      `UPDATE data_subject_requests
          SET status = $2,
              responded_at = ${respondedAt},
              closed_at    = ${closedAt},
              handled_by   = COALESCE($3, handled_by),
              proof_hash   = COALESCE($4, proof_hash),
              updated_at   = now()
        WHERE id = $1
        RETURNING *`,
      [id, status, handledBy, proofHash]
    );
    await client.query(
      `INSERT INTO data_subject_request_events
         (request_id, from_status, to_status, note, actor_user_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, fromStatus, status, note, handledBy]
    );
    return serializeDSR(r.rows[0]);
  });
}

function serializeDSR(row) {
  return {
    id:           row.id,
    userId:       row.user_id,
    businessId:   row.business_id,
    guestPhone:   row.guest_phone,
    contactEmail: row.contact_email,
    requestType:  row.request_type,
    status:       row.status,
    details:      row.details,
    source:       row.source,
    slaDueAt:     row.sla_due_at,
    respondedAt:  row.responded_at,
    closedAt:     row.closed_at,
    handledBy:    row.handled_by,
    proofHash:    row.proof_hash,
    createdAt:    row.created_at,
    updatedAt:    row.updated_at,
  };
}

// ────────────────────────────────────────────────────────────────────
// 3. Grievance complaints
// ────────────────────────────────────────────────────────────────────

async function fileGrievance({
  userId = null,
  businessId = null,
  complainantName = null,
  complainantEmail = null,
  complainantPhone = null,
  category = 'other',
  subject,
  body,
}) {
  if (!subject || !body) throw new BadRequest('subject and body are required');
  if (!complainantEmail && !complainantPhone && !userId) {
    throw new BadRequest('At least one contact identifier required (email/phone/userId)');
  }
  const r = await query(
    `INSERT INTO grievance_complaints
       (business_id, user_id, complainant_name, complainant_email, complainant_phone,
        category, subject, body)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, status, ack_due_at, resolve_due_at, created_at`,
    [businessId, userId, complainantName, complainantEmail, complainantPhone,
     category, subject, body]
  );
  // Founder bug #15 (2026-08-25): DPDP acknowledgement duty — notify the
  // owner + ack the complainant. Best-effort, never fails the insert above.
  _dispatchComplianceEmails({
    kind: 'grievance',
    refId: r.rows[0].id,
    businessId,
    principalEmail: complainantEmail,
    summaryHtml: `<p>Category: <b>${category}</b><br/>Subject: <b>${subject}</b></p>`,
    ackDueAt: r.rows[0].ack_due_at,
    resolveDueAt: r.rows[0].resolve_due_at,
  });
  return {
    id:           r.rows[0].id,
    status:       r.rows[0].status,
    ackDueAt:     r.rows[0].ack_due_at,
    resolveDueAt: r.rows[0].resolve_due_at,
    createdAt:    r.rows[0].created_at,
  };
}

async function listGrievances({ status = null, businessId = null, limit = 100 } = {}) {
  const params = [];
  const where = [];
  if (status) {
    if (!GRIEVANCE_STATUS.has(status)) throw new BadRequest(`Unknown status "${status}"`);
    params.push(status); where.push(`status = $${params.length}`);
  }
  if (businessId) { params.push(businessId); where.push(`business_id = $${params.length}`); }
  params.push(Math.min(Math.max(limit, 1), 500));

  const r = await query(
    `SELECT id, business_id, user_id, complainant_name, complainant_email,
            complainant_phone, category, subject, body, status,
            acknowledged_at, resolved_at, resolution_note, handled_by,
            ack_due_at, resolve_due_at, created_at, updated_at
       FROM grievance_complaints
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY created_at DESC
      LIMIT $${params.length}`,
    params
  );
  return r.rows.map(g => ({
    id:               g.id,
    businessId:       g.business_id,
    userId:           g.user_id,
    complainantName:  g.complainant_name,
    complainantEmail: g.complainant_email,
    complainantPhone: g.complainant_phone,
    category:         g.category,
    subject:          g.subject,
    body:             g.body,
    status:           g.status,
    acknowledgedAt:   g.acknowledged_at,
    resolvedAt:       g.resolved_at,
    resolutionNote:   g.resolution_note,
    handledBy:        g.handled_by,
    ackDueAt:         g.ack_due_at,
    resolveDueAt:     g.resolve_due_at,
    createdAt:        g.created_at,
    updatedAt:        g.updated_at,
  }));
}

async function updateGrievance({ id, status, resolutionNote = null, handledBy = null }) {
  if (!GRIEVANCE_STATUS.has(status)) throw new BadRequest(`Unknown status "${status}"`);
  const r = await query(
    `UPDATE grievance_complaints
        SET status = $2,
            acknowledged_at = CASE WHEN $2 IN ('acknowledged','resolved','rejected','escalated')
                                    AND acknowledged_at IS NULL THEN now()
                                  ELSE acknowledged_at END,
            resolved_at     = CASE WHEN $2 IN ('resolved','rejected') AND resolved_at IS NULL THEN now()
                                  ELSE resolved_at END,
            resolution_note = COALESCE($3, resolution_note),
            handled_by      = COALESCE($4, handled_by),
            updated_at      = now()
      WHERE id = $1
      RETURNING id`,
    [id, status, resolutionNote, handledBy]
  );
  if (!r.rows[0]) throw new NotFound('Grievance not found');
  return { id: r.rows[0].id, status };
}

// ────────────────────────────────────────────────────────────────────
// 4. Breach incidents
// ────────────────────────────────────────────────────────────────────

async function logBreach({
  scope = 'platform',
  businessId = null,
  occurredAt = null,
  category,
  severity,
  affectedCount = null,
  dataCategories = [],
  summary,
  rootCause = null,
  remediation = null,
  createdBy = null,
}) {
  if (!category) throw new BadRequest('category is required');
  if (!['low','medium','high','critical'].includes(severity)) {
    throw new BadRequest('severity must be low|medium|high|critical');
  }
  if (!summary) throw new BadRequest('summary is required');

  const r = await query(
    `INSERT INTO breach_incidents
       (scope, business_id, occurred_at, category, severity,
        affected_count, data_categories, summary, root_cause,
        remediation, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id, status, detected_at, created_at`,
    [scope, businessId, occurredAt, category, severity,
     affectedCount, dataCategories, summary, rootCause, remediation, createdBy]
  );
  return { id: r.rows[0].id, status: r.rows[0].status, detectedAt: r.rows[0].detected_at };
}

async function updateBreach({ id, status, fields = {} }) {
  if (status && !BREACH_STATUS.has(status)) throw new BadRequest(`Unknown status "${status}"`);
  // Allowed mutable fields (notification timestamps + remediation).
  const allowed = ['root_cause', 'remediation', 'dpb_notified_at',
                   'cert_in_notified_at', 'users_notified_at', 'ack_ref',
                   'affected_count'];
  const sets = [];
  const params = [id];
  if (status) { params.push(status); sets.push(`status = $${params.length}`); }
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(fields, k)) {
      params.push(fields[k]);
      sets.push(`${k} = $${params.length}`);
    }
  }
  if (!sets.length) throw new BadRequest('Nothing to update');
  sets.push('updated_at = now()');
  const r = await query(
    `UPDATE breach_incidents SET ${sets.join(', ')} WHERE id = $1 RETURNING id`,
    params
  );
  if (!r.rows[0]) throw new NotFound('Breach incident not found');
  return { id: r.rows[0].id };
}

async function listBreaches({ status = null, limit = 100 } = {}) {
  const params = [];
  const where = [];
  if (status) { params.push(status); where.push(`status = $${params.length}`); }
  params.push(Math.min(Math.max(limit, 1), 500));
  const r = await query(
    `SELECT * FROM breach_incidents
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY detected_at DESC
      LIMIT $${params.length}`,
    params
  );
  return r.rows;
}

// ────────────────────────────────────────────────────────────────────
// 5. Compliance settings (singleton)
// ────────────────────────────────────────────────────────────────────

async function getSettings() {
  const r = await query(`SELECT * FROM compliance_settings WHERE id = 1`);
  const s = r.rows[0] || {};
  return {
    grievanceOfficer: {
      name:    s.grievance_officer_name,
      email:   s.grievance_officer_email,
      phone:   s.grievance_officer_phone,
      address: s.grievance_officer_address,
    },
    dataProtectionOfficer: {
      name:  s.dpo_name,
      email: s.dpo_email,
    },
    legalEntity: {
      name:    s.legal_entity_name,
      address: s.legal_entity_address,
      cin:     s.legal_entity_cin,
      gstin:   s.legal_entity_gstin,
    },
    privacyPolicyVersion:   s.privacy_policy_version,
    termsOfServiceVersion:  s.terms_of_service_version,
    updatedAt: s.updated_at,
  };
}

async function updateSettings(input) {
  const map = {
    grievanceOfficerName:    'grievance_officer_name',
    grievanceOfficerEmail:   'grievance_officer_email',
    grievanceOfficerPhone:   'grievance_officer_phone',
    grievanceOfficerAddress: 'grievance_officer_address',
    dpoName:                 'dpo_name',
    dpoEmail:                'dpo_email',
    legalEntityName:         'legal_entity_name',
    legalEntityAddress:      'legal_entity_address',
    legalEntityCin:          'legal_entity_cin',
    legalEntityGstin:        'legal_entity_gstin',
    privacyPolicyVersion:    'privacy_policy_version',
    termsOfServiceVersion:   'terms_of_service_version',
  };
  const sets = [];
  const params = [];
  for (const [k, col] of Object.entries(map)) {
    if (Object.prototype.hasOwnProperty.call(input, k)) {
      params.push(input[k]);
      sets.push(`${col} = $${params.length}`);
    }
  }
  if (!sets.length) return getSettings();
  sets.push('updated_at = now()');
  await query(`UPDATE compliance_settings SET ${sets.join(', ')} WHERE id = 1`, params);
  return getSettings();
}

// ────────────────────────────────────────────────────────────────────
// 6. Data subject EXPORT — collects everything we have on a user
// ────────────────────────────────────────────────────────────────────

/**
 * Build a portable JSON dump of all personal data we hold on `userId`.
 *
 * Strategy: best-effort — for each table that holds user-linked data
 * we run a SELECT scoped to user_id (or by an FK we know about).
 * We deliberately keep this read-only; the caller is responsible for
 * delivering the file and recording the DSR closure.
 */
async function exportUserData(userId) {
  if (!userId) throw new BadRequest('userId required');
  const dump = { exportedAt: new Date().toISOString(), userId, sections: {} };

  // Profile
  const u = await query(
    `SELECT id, email, display_name, phone, photo_url,
            created_at, last_seen_at, locale
       FROM users WHERE id = $1`,
    [userId]
  );
  dump.sections.profile = u.rows[0] || null;

  // Business memberships. The membership table uses `joined_at`, not
  // `created_at` — column was named for the semantic that the row
  // records the moment the user joined that business.
  const m = await query(
    `SELECT bu.business_id, b.name AS business_name, bu.role, bu.joined_at
       FROM business_users bu
       LEFT JOIN businesses b ON b.id = bu.business_id
      WHERE bu.user_id = $1`,
    [userId]
  );
  dump.sections.businessMemberships = m.rows;

  // Consent history
  dump.sections.consents = await consentHistory({ userId, limit: 5000 });

  // Data subject requests (history of their own requests)
  dump.sections.dataSubjectRequests = await listDataSubjectRequests({ userId, limit: 500 });

  // Grievances they filed
  const g = await query(
    `SELECT id, business_id, category, subject, body, status,
            acknowledged_at, resolved_at, created_at
       FROM grievance_complaints WHERE user_id = $1`,
    [userId]
  );
  dump.sections.grievances = g.rows;

  // Stamp the dump with a sha-256 so the receiver can detect tampering
  const hash = crypto.createHash('sha256')
    .update(JSON.stringify(dump))
    .digest('hex');
  return { dump, hash };
}

/**
 * Soft-erase a user. We deliberately do NOT hard-delete in the same
 * transaction as the API call — DPDP allows the fiduciary to retain
 * data for legal/tax compliance even after erasure of identifiers.
 *
 * Steps:
 *   1. Replace direct identifiers on `users` row with hashed tokens
 *   2. Clear marketing-consent rows (append withdrawal events)
 *   3. Insert a DSR `completed` for traceability
 *   4. Caller is expected to schedule a hard-delete job once the
 *      retention window (per finance/tax law) elapses.
 */
async function eraseUser({ userId, reason = 'self_service_erasure', actorUserId = null }) {
  if (!userId) throw new BadRequest('userId required');
  return withTransaction(async (client) => {
    const u = await client.query(
      `SELECT id, email FROM users WHERE id = $1 FOR UPDATE`,
      [userId]
    );
    if (!u.rows[0]) throw new NotFound('User not found');

    const anonId = crypto.createHash('sha256').update(userId + Date.now()).digest('hex').slice(0, 16);
    const erasedEmail = `erased+${anonId}@erased.namastepos.invalid`;

    await client.query(
      `UPDATE users
          SET email         = $2,
              display_name  = 'Erased User',
              phone         = NULL,
              photo_url     = NULL,
              google_sub    = NULL,
              password_hash = NULL,
              is_active     = FALSE,
              updated_at    = now()
        WHERE id = $1`,
      [userId, erasedEmail]
    );

    // Withdrawal entries — leaves an audit trail that we received
    // the erasure request even after profile fields are nuked.
    for (const key of ['marketing_email','marketing_whatsapp','marketing_sms']) {
      await client.query(
        `INSERT INTO consent_events
           (user_id, consent_key, granted, source, context)
         VALUES ($1, $2, FALSE, 'erasure_request', $3)`,
        [userId, key, JSON.stringify({ reason })]
      );
    }

    // Record DSR completion
    const dsr = await client.query(
      `INSERT INTO data_subject_requests
         (user_id, request_type, status, source, details, responded_at, closed_at, handled_by)
       VALUES ($1, 'erasure', 'completed', 'self_service',
               $2, now(), now(), $3)
       RETURNING id`,
      [userId, JSON.stringify({ reason }), actorUserId]
    );
    return { userId, requestId: dsr.rows[0].id };
  });
}

module.exports = {
  // Consent
  CONSENT_KEYS: Array.from(CONSENT_KEYS),
  recordConsent,
  currentConsents,
  consentHistory,
  // DSR
  REQUEST_TYPES: Array.from(REQUEST_TYPES),
  fileDataSubjectRequest,
  listDataSubjectRequests,
  updateDataSubjectRequest,
  // Grievance
  fileGrievance,
  listGrievances,
  updateGrievance,
  // Breach
  logBreach,
  updateBreach,
  listBreaches,
  // Settings
  getSettings,
  updateSettings,
  // Export / erase
  exportUserData,
  eraseUser,
};
