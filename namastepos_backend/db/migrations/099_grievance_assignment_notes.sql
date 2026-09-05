-- 099 — grievance assignment + internal notes (round-3 fix batch 2026-09-06, Bug 3)
--
-- WHY
-- ---------------------------------------------------------------------------
-- The super-admin Compliance → Grievances tab could only LIST and flip the
-- status of DPDP s.13 complaints filed through the public endpoint. The console
-- needs the rest of a grievance desk: record a complaint received out-of-band
-- (phone / email / WhatsApp), assign it to a named admin, and keep an internal
-- running log per complaint that is separate from the customer-facing
-- `resolution_note`. `handled_by` stays what it was (the admin who last changed
-- the status); `assigned_to` is the owner of the case.
--
-- grievance_notes is deliberately NOT support_notes: that table requires a
-- business_id and grievances can be filed against the platform itself
-- (business_id NULL).
--
-- Idempotent: IF NOT EXISTS everywhere.

ALTER TABLE grievance_complaints
  ADD COLUMN IF NOT EXISTS assigned_to uuid REFERENCES admin_users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_grievance_assigned
  ON grievance_complaints (assigned_to, status)
  WHERE assigned_to IS NOT NULL;

CREATE TABLE IF NOT EXISTS grievance_notes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grievance_id  uuid NOT NULL REFERENCES grievance_complaints(id) ON DELETE CASCADE,
  admin_id      uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  body          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_grievance_notes_grievance
  ON grievance_notes (grievance_id, created_at DESC);
