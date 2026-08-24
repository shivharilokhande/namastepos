-- Migration 041 — DPDP Act 2023 compliance scaffolding.
--
-- The Digital Personal Data Protection Act 2023 requires every data
-- fiduciary (us, in our role as the SaaS) and our customers (the
-- restaurants, in their role as fiduciaries of their diners' data) to
-- be able to demonstrate:
--
--   1. **Consent** — when, for what purpose, and how the principal
--      consented. Withdrawal must be at least as easy as granting it.
--   2. **Data subject rights** — access, correction, erasure,
--      portability. Each request must be tracked with a status and an
--      SLA timer.
--   3. **Grievance redressal** — every fiduciary must publish a
--      grievance officer. Complaints filed with that officer must be
--      acknowledged and resolved within a defined window.
--   4. **Breach notification** — significant breaches must be reported
--      to the Data Protection Board within 72 hours.
--
-- This migration creates the persistence layer for all four. The
-- application layer wires them up in `complianceService.js` and the
-- `/v1/me/*` + `/v1/businesses/:bid/compliance/*` routes.
--
-- IMPORTANT: none of the tables here are mutable by application code.
-- Inserts and SELECTs only — we do NOT issue UPDATE/DELETE on
-- consent_events or breach_incidents from any service. (status changes
-- on data_subject_requests and grievance_complaints are tracked via
-- separate `*_status_history` rows below, so the original record
-- remains immutable.)

-- ─── 1. consent_events ────────────────────────────────────────────────
-- Append-only log of every consent grant or withdrawal.
--
-- Principal can be:
--   - A registered user      (user_id NOT NULL)
--   - A guest QR diner       (guest_phone NOT NULL, user_id NULL)
--   - An unauthenticated
--     site visitor (cookies) (session_id NOT NULL, user_id NULL)
--
-- One of {user_id, guest_phone, session_id} must be present.

CREATE TABLE IF NOT EXISTS consent_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Who consented (exactly one of these will be set, plus optional ones)
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  business_id     uuid REFERENCES businesses(id) ON DELETE SET NULL,
  guest_phone     varchar(20),
  session_id      varchar(128),

  -- What they consented to
  -- Keys we use today (extend freely — service validates the key list):
  --   privacy_policy   — accepted the privacy notice
  --   terms_of_service — accepted the ToS
  --   marketing_email  — opt-in to marketing email
  --   marketing_whatsapp — opt-in to WhatsApp marketing
  --   marketing_sms    — opt-in to SMS marketing
  --   cookies_analytics — accepted analytics cookies
  --   cookies_marketing — accepted marketing cookies
  --   data_sharing_payment — accepted sharing data with payment processor
  consent_key     varchar(64) NOT NULL,

  -- granted=true is a positive consent; granted=false is a withdrawal.
  -- We never UPDATE old rows — we append a new row when consent flips.
  granted         boolean NOT NULL,

  -- Version of the policy/ToS the principal saw at the moment of consent.
  -- e.g. 'privacy-2026-05-26', 'tos-2026-05-26'.
  policy_version  varchar(64),

  -- Evidence trail — used to defend the consent record in a regulator
  -- query or DSAR audit. We deliberately keep these as plain columns
  -- (instead of jsonb) so they're indexable + queryable.
  source          varchar(64) NOT NULL,        -- mobile_app / dashboard / qr_menu / cookie_banner / api
  ip_address      inet,
  user_agent      text,
  -- Free-form context (e.g. {"location": "checkout", "campaign": "x"})
  context         jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at      timestamptz NOT NULL DEFAULT now(),

  -- At least one principal identifier must be present
  CONSTRAINT consent_events_has_principal CHECK (
    user_id IS NOT NULL OR guest_phone IS NOT NULL OR session_id IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_consent_events_user
  ON consent_events (user_id, consent_key, created_at DESC)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_consent_events_guest_phone
  ON consent_events (guest_phone, consent_key, created_at DESC)
  WHERE guest_phone IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_consent_events_session
  ON consent_events (session_id, consent_key, created_at DESC)
  WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_consent_events_business
  ON consent_events (business_id, created_at DESC)
  WHERE business_id IS NOT NULL;

-- ─── 2. data_subject_requests ────────────────────────────────────────
-- DPDP s.11–13 — principal's rights of access, correction, erasure,
-- portability. Every request is tracked here.

CREATE TABLE IF NOT EXISTS data_subject_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  business_id     uuid REFERENCES businesses(id) ON DELETE SET NULL,
  -- Allow phone-only requests (guest diner who has no account but who
  -- ordered via QR; they have a right to ask the restaurant for their data)
  guest_phone     varchar(20),
  contact_email   varchar(255),

  -- access | correction | erasure | portability | withdraw_consent
  request_type    varchar(32) NOT NULL,
  -- pending | in_review | completed | rejected | partial
  status          varchar(32) NOT NULL DEFAULT 'pending',
  -- Free-form payload (what they asked for, what we did, why we rejected)
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Where the request came from (mobile_app / dashboard / email / phone)
  source          varchar(64) NOT NULL DEFAULT 'self_service',

  -- SLA — DPDP doesn't fix a number, but industry norm is 30 days. We
  -- default to 30; super-admin can change per request.
  sla_due_at      timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  responded_at    timestamptz,
  closed_at       timestamptz,

  -- Who handled it (super-admin user id)
  handled_by      uuid,
  -- Hash of the export file or proof-of-deletion (audit trail)
  proof_hash      varchar(128),

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT dsr_has_principal CHECK (
    user_id IS NOT NULL OR guest_phone IS NOT NULL OR contact_email IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_dsr_user
  ON data_subject_requests (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dsr_status
  ON data_subject_requests (status, sla_due_at);
CREATE INDEX IF NOT EXISTS idx_dsr_business
  ON data_subject_requests (business_id, created_at DESC)
  WHERE business_id IS NOT NULL;

-- Status changes are tracked in a separate table so the original
-- request row stays immutable.
CREATE TABLE IF NOT EXISTS data_subject_request_events (
  id              bigserial PRIMARY KEY,
  request_id      uuid NOT NULL REFERENCES data_subject_requests(id) ON DELETE CASCADE,
  from_status     varchar(32),
  to_status       varchar(32) NOT NULL,
  note            text,
  actor_user_id   uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dsr_events_request
  ON data_subject_request_events (request_id, created_at);

-- ─── 3. grievance_complaints ─────────────────────────────────────────
-- DPDP s.13 — every fiduciary must publish a grievance officer.
-- Complaints filed via /v1/grievance go here.

CREATE TABLE IF NOT EXISTS grievance_complaints (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Either filed against the platform (business_id NULL) or against a
  -- specific business (business_id set).
  business_id     uuid REFERENCES businesses(id) ON DELETE SET NULL,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  complainant_name  varchar(255),
  complainant_email varchar(255),
  complainant_phone varchar(20),

  -- Category — privacy | data_misuse | consent | security | billing | other
  category        varchar(32) NOT NULL DEFAULT 'other',
  subject         varchar(255) NOT NULL,
  body            text NOT NULL,

  -- received | acknowledged | resolved | rejected | escalated
  status          varchar(32) NOT NULL DEFAULT 'received',
  acknowledged_at timestamptz,
  resolved_at     timestamptz,
  resolution_note text,
  handled_by      uuid,

  -- SLA — industry norm is acknowledge in 48h, resolve in 30 days
  ack_due_at      timestamptz NOT NULL DEFAULT (now() + interval '48 hours'),
  resolve_due_at  timestamptz NOT NULL DEFAULT (now() + interval '30 days'),

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_grievance_status
  ON grievance_complaints (status, resolve_due_at);
CREATE INDEX IF NOT EXISTS idx_grievance_business
  ON grievance_complaints (business_id, created_at DESC)
  WHERE business_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_grievance_user
  ON grievance_complaints (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

-- ─── 4. breach_incidents ─────────────────────────────────────────────
-- DPDP s.8(6) — every personal data breach must be reported to the
-- Data Protection Board AND to affected principals.
-- IT Rules 2013 — CERT-In requires reporting within 6 hours of
-- noticing certain categories of incident.

CREATE TABLE IF NOT EXISTS breach_incidents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'platform' (us) or 'business' (one of our customers' tenants)
  scope           varchar(16) NOT NULL DEFAULT 'platform',
  business_id     uuid REFERENCES businesses(id) ON DELETE SET NULL,

  -- detected_at = when we noticed; occurred_at = when it actually started
  detected_at     timestamptz NOT NULL DEFAULT now(),
  occurred_at     timestamptz,

  -- Category — unauthorized_access | data_exfil | data_loss
  --          | misconfiguration | third_party | other
  category        varchar(32) NOT NULL,
  severity        varchar(16) NOT NULL,        -- low | medium | high | critical
  affected_count  integer,                     -- approx. principals affected
  data_categories text[],                      -- e.g. ['email','phone','order_history']

  summary         text NOT NULL,
  root_cause      text,
  remediation     text,

  -- Notification status
  dpb_notified_at      timestamptz,    -- Data Protection Board
  cert_in_notified_at  timestamptz,    -- CERT-In (where applicable)
  users_notified_at    timestamptz,    -- mass user notification
  ack_ref             varchar(128),    -- regulator acknowledgement reference

  -- detected | triaging | contained | notified | closed
  status          varchar(32) NOT NULL DEFAULT 'detected',
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_breach_status_severity
  ON breach_incidents (status, severity, detected_at DESC);

-- ─── 5. compliance_settings ──────────────────────────────────────────
-- Single-row config holding the platform's grievance officer contact.
-- Editable only by super-admin via /v1/admin/compliance-settings.

CREATE TABLE IF NOT EXISTS compliance_settings (
  id                          smallint PRIMARY KEY DEFAULT 1,
  -- Grievance officer (platform-level)
  grievance_officer_name      varchar(255),
  grievance_officer_email     varchar(255),
  grievance_officer_phone     varchar(40),
  grievance_officer_address   text,

  -- Data protection officer (DPDP "significant data fiduciary" trigger;
  -- not mandatory until we cross the threshold, but field exists now)
  dpo_name                    varchar(255),
  dpo_email                   varchar(255),

  -- Legal / registered entity
  legal_entity_name           varchar(255),
  legal_entity_address        text,
  legal_entity_cin            varchar(32),     -- Company Identification Number
  legal_entity_gstin          varchar(15),

  -- Currently-published policy versions
  privacy_policy_version      varchar(64),
  terms_of_service_version    varchar(64),

  updated_at                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT compliance_settings_singleton CHECK (id = 1)
);

-- Seed the single row so the read path never has to handle "empty".
INSERT INTO compliance_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
