// NamastePOS backend - DPDP compliance endpoints
//
// Two surfaces are mounted off this controller:
//
//   /v1/me/...                — self-service (any authenticated user)
//     GET    /me/consents     — current state of every consent key
//     GET    /me/consents/history — full audit trail
//     POST   /me/consents     — record consent grant or withdrawal
//     POST   /me/dsr          — file a data-subject request
//     GET    /me/dsr          — list this user's own DSRs
//     GET    /me/export       — download portable JSON dump of own data
//     DELETE /me/account      — file + execute erasure request
//
//   /v1/compliance/...        — public, no auth (DPDP requires the
//     GET    /compliance/grievance-officer — published contact
//     POST   /compliance/grievance         — file a grievance
//     POST   /compliance/consent           — record cookie-banner consent
//
//   /v1/admin/compliance/...  — super-admin only (mounted under admin.routes)

const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const svc = require('../services/complianceService');
const { BadRequest } = require('../utils/errors');

// ── Helpers ──────────────────────────────────────────────────────────

function ipOf(req) {
  return req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || null;
}
function uaOf(req) {
  return req.headers['user-agent'] || null;
}

// ── /me ───────────────────────────────────────────────────────────────

const consentBodySchema = {
  body: Joi.object({
    consentKey:    Joi.string().required(),
    granted:       Joi.boolean().required(),
    policyVersion: Joi.string().max(64).allow(null, ''),
    source:        Joi.string().max(64).default('mobile_app'),
    context:       Joi.object().default({}),
  }),
};

const meRecordConsent = [
  validate(consentBodySchema),
  asyncHandler(async (req, res) => {
    const out = await svc.recordConsent({
      userId:     req.user.id,
      businessId: req.user.businessId || null,
      consentKey: req.body.consentKey,
      granted:    req.body.granted,
      policyVersion: req.body.policyVersion || null,
      source:     req.body.source,
      ipAddress:  ipOf(req),
      userAgent:  uaOf(req),
      context:    req.body.context || {},
    });
    res.status(201).json(out);
  }),
];

const meCurrentConsents = asyncHandler(async (req, res) => {
  const consents = await svc.currentConsents({ userId: req.user.id });
  res.json({ consents });
});

const meConsentHistory = asyncHandler(async (req, res) => {
  const history = await svc.consentHistory({ userId: req.user.id, limit: 500 });
  res.json({ history });
});

const dsrBodySchema = {
  body: Joi.object({
    requestType: Joi.string()
      .valid('access', 'correction', 'erasure', 'portability', 'withdraw_consent')
      .required(),
    details:     Joi.object().default({}),
  }),
};

const meFileDSR = [
  validate(dsrBodySchema),
  asyncHandler(async (req, res) => {
    const out = await svc.fileDataSubjectRequest({
      userId:      req.user.id,
      businessId:  req.user.businessId || null,
      contactEmail: req.user.email || null,
      requestType: req.body.requestType,
      details:     req.body.details,
      source:      'self_service',
    });
    res.status(201).json(out);
  }),
];

const meListDSRs = asyncHandler(async (req, res) => {
  const requests = await svc.listDataSubjectRequests({ userId: req.user.id });
  res.json({ requests });
});

const meExport = asyncHandler(async (req, res) => {
  const { dump, hash } = await svc.exportUserData(req.user.id);
  // Also record the access request for audit
  await svc.fileDataSubjectRequest({
    userId:      req.user.id,
    contactEmail: req.user.email || null,
    requestType: 'portability',
    details:     { auto_completed: true, hash },
    source:      'self_service',
  }).catch(() => null); // best-effort — don't fail the export if logging fails

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="namastepos-data-export-${req.user.id}.json"`);
  res.setHeader('X-NamastePOS-Export-SHA256', hash);
  res.send(JSON.stringify({ ...dump, sha256: hash }, null, 2));
});

const meEraseAccount = asyncHandler(async (req, res) => {
  // P0-1: impersonated tokens cannot erase the impersonated user
  if (req.user.impersonator) {
    return res.status(403).json({ error: { code: 'IMPERSONATION_FORBIDDEN',
      message: 'Account erasure cannot be performed via impersonation' } });
  }
  const out = await svc.eraseUser({
    userId:      req.user.id,
    reason:      'self_service_account_deletion',
    actorUserId: req.user.id,
  });
  res.json({ ...out, message: 'Account erased. Some records may be retained for legal compliance.' });
});

// PATCH /me/correct — correction request. We don't auto-apply the
// correction (that's the user's responsibility via existing /auth/me
// PATCH endpoint); we just record the DSR so the audit trail exists.
const meCorrectSchema = {
  body: Joi.object({
    field:   Joi.string().required(),
    newValue: Joi.any().required(),
    reason:  Joi.string().allow('', null).max(500),
  }),
};
const meFileCorrection = [
  validate(meCorrectSchema),
  asyncHandler(async (req, res) => {
    const out = await svc.fileDataSubjectRequest({
      userId:       req.user.id,
      contactEmail: req.user.email || null,
      requestType:  'correction',
      details:      {
        field: req.body.field,
        newValue: req.body.newValue,
        reason: req.body.reason || null,
      },
      source:       'self_service',
    });
    res.status(201).json(out);
  }),
];

// ── /v1/compliance — public, no auth ──────────────────────────────────

const publicGrievanceOfficer = asyncHandler(async (_req, res) => {
  const s = await svc.getSettings();
  // Only return the published-officer fields, not the full settings blob.
  res.json({
    grievanceOfficer: s.grievanceOfficer,
    dataProtectionOfficer: s.dataProtectionOfficer,
    legalEntity: {
      name:    s.legalEntity?.name,
      address: s.legalEntity?.address,
    },
    privacyPolicyVersion:  s.privacyPolicyVersion,
    termsOfServiceVersion: s.termsOfServiceVersion,
  });
});

// Founder bug (2026-08-25): this schema used to end with
// `.or('complainantEmail', 'complainantPhone')`, which made a contact field
// mandatory for EVERY caller. The dashboard Privacy page posts here as a
// signed-in owner and never collects email/phone, so every submission died
// with an opaque "BAD_REQUEST: Validation failed". Joi can't see req.user,
// so the contact-or-authenticated rule now lives in the handler below where
// the (optionally decoded) principal is visible.
const grievanceBodySchema = {
  body: Joi.object({
    businessId:       Joi.string().uuid().allow(null),
    complainantName:  Joi.string().max(255).allow('', null),
    complainantEmail: Joi.string().email().allow('', null),
    complainantPhone: Joi.string().max(20).allow('', null),
    category:         Joi.string().valid(
      'privacy','data_misuse','consent','security','billing','other'
    ).default('other'),
    subject: Joi.string().max(255).required(),
    body:    Joi.string().max(5000).required(),
  }),
};

const publicFileGrievance = [
  validate(grievanceBodySchema),
  asyncHandler(async (req, res) => {
    // Fall back to the token's email/business for signed-in filers so the
    // Grievance Officer always has a reply channel + tenant context without
    // forcing the dashboard to re-collect data we already hold (DPDP data
    // minimisation). req.user is set by optionalAuth on the route (2026-08-25).
    const complainantEmail = req.body.complainantEmail || req.user?.email || null;
    const complainantPhone = req.body.complainantPhone || null;
    if (!req.user?.id && !complainantEmail && !complainantPhone) {
      // Mirror validate.js output shape, but put the field hint in the
      // MESSAGE too — the dashboard's apiError() only surfaces `message`,
      // and "Validation failed" alone left the founder guessing.
      throw new BadRequest(
        'Please provide complainantEmail or complainantPhone (or sign in) so the Grievance Officer can reply',
        ['body.complainantEmail: required when not signed in (or provide body.complainantPhone)']
      );
    }
    const out = await svc.fileGrievance({
      userId: req.user?.id || null,
      businessId: req.body.businessId || req.user?.businessId || null,
      complainantName:  req.body.complainantName || null,
      complainantEmail,
      complainantPhone,
      category:         req.body.category,
      subject:          req.body.subject,
      body:             req.body.body,
    });
    res.status(201).json(out);
  }),
];

// Cookie-banner consent (anonymous) — needs a sessionId from client
const publicConsentSchema = {
  body: Joi.object({
    sessionId:     Joi.string().min(8).max(128).required(),
    consentKey:    Joi.string().required(),
    granted:       Joi.boolean().required(),
    policyVersion: Joi.string().max(64).allow('', null),
    source:        Joi.string().max(64).default('cookie_banner'),
  }),
};
const publicRecordConsent = [
  validate(publicConsentSchema),
  asyncHandler(async (req, res) => {
    const out = await svc.recordConsent({
      sessionId:     req.body.sessionId,
      consentKey:    req.body.consentKey,
      granted:       req.body.granted,
      policyVersion: req.body.policyVersion || null,
      source:        req.body.source,
      ipAddress:     ipOf(req),
      userAgent:     uaOf(req),
      context:       { anon: true },
    });
    res.status(201).json(out);
  }),
];

// Guest QR diner can withdraw marketing consent by phone (no account)
const guestConsentSchema = {
  body: Joi.object({
    guestPhone:    Joi.string().min(6).max(20).required(),
    consentKey:    Joi.string().required(),
    granted:       Joi.boolean().required(),
    policyVersion: Joi.string().max(64).allow('', null),
    source:        Joi.string().max(64).default('qr_menu'),
  }),
};
const guestRecordConsent = [
  validate(guestConsentSchema),
  asyncHandler(async (req, res) => {
    const out = await svc.recordConsent({
      guestPhone:    req.body.guestPhone,
      consentKey:    req.body.consentKey,
      granted:       req.body.granted,
      policyVersion: req.body.policyVersion || null,
      source:        req.body.source,
      ipAddress:     ipOf(req),
      userAgent:     uaOf(req),
      context:       { channel: 'guest_qr' },
    });
    res.status(201).json(out);
  }),
];

// ── Admin endpoints (super-admin only) ────────────────────────────────

const adminListDSRs = asyncHandler(async (req, res) => {
  const requests = await svc.listDataSubjectRequests({
    status: req.query.status || null,
    limit:  parseInt(req.query.limit || '100', 10),
  });
  res.json({ requests });
});

const adminUpdateDSRSchema = {
  body: Joi.object({
    status:    Joi.string().valid('pending','in_review','completed','rejected','partial').required(),
    note:      Joi.string().max(2000).allow('', null),
    proofHash: Joi.string().max(128).allow('', null),
  }),
};
const adminUpdateDSR = [
  validate(adminUpdateDSRSchema),
  asyncHandler(async (req, res) => {
    const out = await svc.updateDataSubjectRequest({
      id:        req.params.id,
      status:    req.body.status,
      note:      req.body.note || null,
      proofHash: req.body.proofHash || null,
      handledBy: req.user.id,
    });
    res.json(out);
  }),
];

const adminListGrievances = asyncHandler(async (req, res) => {
  const grievances = await svc.listGrievances({
    status:     req.query.status || null,
    businessId: req.query.businessId || null,
    limit:      parseInt(req.query.limit || '100', 10),
  });
  res.json({ grievances });
});

const adminUpdateGrievanceSchema = {
  body: Joi.object({
    status:         Joi.string().valid('received','acknowledged','resolved','rejected','escalated').required(),
    resolutionNote: Joi.string().max(2000).allow('', null),
  }),
};
const adminUpdateGrievance = [
  validate(adminUpdateGrievanceSchema),
  asyncHandler(async (req, res) => {
    const out = await svc.updateGrievance({
      id:             req.params.id,
      status:         req.body.status,
      resolutionNote: req.body.resolutionNote || null,
      handledBy:      req.user.id,
    });
    res.json(out);
  }),
];

const adminListBreaches = asyncHandler(async (req, res) => {
  const breaches = await svc.listBreaches({
    status: req.query.status || null,
    limit:  parseInt(req.query.limit || '100', 10),
  });
  res.json({ breaches });
});

const adminLogBreachSchema = {
  body: Joi.object({
    scope:          Joi.string().valid('platform','business').default('platform'),
    businessId:     Joi.string().uuid().allow(null),
    occurredAt:     Joi.date().iso().allow(null),
    category:       Joi.string().required(),
    severity:       Joi.string().valid('low','medium','high','critical').required(),
    affectedCount:  Joi.number().integer().min(0).allow(null),
    dataCategories: Joi.array().items(Joi.string()).default([]),
    summary:        Joi.string().max(2000).required(),
    rootCause:      Joi.string().max(2000).allow('', null),
    remediation:    Joi.string().max(2000).allow('', null),
  }),
};
const adminLogBreach = [
  validate(adminLogBreachSchema),
  asyncHandler(async (req, res) => {
    const out = await svc.logBreach({
      ...req.body,
      createdBy: req.user.id,
    });
    res.status(201).json(out);
  }),
];

const adminUpdateBreachSchema = {
  body: Joi.object({
    status: Joi.string().valid('detected','triaging','contained','notified','closed'),
    fields: Joi.object().default({}),
  }),
};
const adminUpdateBreach = [
  validate(adminUpdateBreachSchema),
  asyncHandler(async (req, res) => {
    const out = await svc.updateBreach({
      id:     req.params.id,
      status: req.body.status,
      fields: req.body.fields || {},
    });
    res.json(out);
  }),
];

// ── Data retention (2026-08-28) ───────────────────────────────────────
const retention = require('../services/retentionService');

const adminGetRetention = asyncHandler(async (_req, res) => {
  res.json(await retention.getConfig());
});

const adminUpdateRetentionSchema = {
  body: Joi.object({
    deletedBusinessDays: Joi.number().integer().min(0).max(3650),
    auditLogDays:        Joi.number().integer().min(0).max(3650),
    cookieConsentDays:   Joi.number().integer().min(0).max(3650),
  }).min(1),
};
const adminUpdateRetention = [
  validate(adminUpdateRetentionSchema),
  asyncHandler(async (req, res) => {
    res.json(await retention.saveConfig(req.body, { adminId: req.user.id }));
  }),
];

const adminPreviewRetention = asyncHandler(async (_req, res) => {
  res.json(await retention.preview());
});

const adminRunRetention = asyncHandler(async (req, res) => {
  res.json(await retention.sweep({ adminId: req.user.id }));
});

const adminGetSettings = asyncHandler(async (_req, res) => {
  res.json(await svc.getSettings());
});

const adminUpdateSettingsSchema = {
  body: Joi.object({
    grievanceOfficerName:    Joi.string().max(255).allow('', null),
    grievanceOfficerEmail:   Joi.string().email().allow('', null),
    grievanceOfficerPhone:   Joi.string().max(40).allow('', null),
    grievanceOfficerAddress: Joi.string().max(2000).allow('', null),
    dpoName:                 Joi.string().max(255).allow('', null),
    dpoEmail:                Joi.string().email().allow('', null),
    legalEntityName:         Joi.string().max(255).allow('', null),
    legalEntityAddress:      Joi.string().max(2000).allow('', null),
    legalEntityCin:          Joi.string().max(32).allow('', null),
    legalEntityGstin:        Joi.string().max(15).allow('', null),
    privacyPolicyVersion:    Joi.string().max(64).allow('', null),
    termsOfServiceVersion:   Joi.string().max(64).allow('', null),
  }).min(1),
};
const adminUpdateSettings = [
  validate(adminUpdateSettingsSchema),
  asyncHandler(async (req, res) => {
    const out = await svc.updateSettings(req.body);
    res.json(out);
  }),
];

module.exports = {
  // me
  meRecordConsent,
  meCurrentConsents,
  meConsentHistory,
  meFileDSR,
  meListDSRs,
  meExport,
  meEraseAccount,
  meFileCorrection,
  // public
  publicGrievanceOfficer,
  publicFileGrievance,
  publicRecordConsent,
  guestRecordConsent,
  // admin
  adminListDSRs,
  adminUpdateDSR,
  adminListGrievances,
  adminUpdateGrievance,
  adminListBreaches,
  adminLogBreach,
  adminUpdateBreach,
  adminGetSettings,
  adminUpdateSettings,
  adminGetRetention,
  adminUpdateRetention,
  adminPreviewRetention,
  adminRunRetention,
};
