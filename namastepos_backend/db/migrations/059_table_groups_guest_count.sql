-- 059: Joined tables (one session across many physical tables) + guest count
--      (founder round-2 Wave B, 25 Aug)
--
-- Guest count: NO schema change needed — table_sessions.guest_count already
-- exists (migration 006, DEFAULT 2). The "always shows 2" bug was the
-- dashboard never sending guestCount; fixed in TablesPage + tableService.
--
-- 1. Joined tables. WHY an UUID[] column instead of a session_tables join
--    table: a session has exactly ONE primary table (table_sessions.table_id,
--    guarded by the uq_open_session partial unique index) and typically 1-2
--    extra tables for big groups. A whole join table would need its own
--    tenant scoping, FK cleanup and open/closed lifecycle for what is a tiny,
--    append-only list read as a unit — the array keeps the "one open session
--    per table" invariant model unchanged and matches this schema's style of
--    denormalised session fields (e.g. total_paise).
--    NULL = normal single-table session (all pre-existing rows).
ALTER TABLE table_sessions
  ADD COLUMN IF NOT EXISTS joined_table_ids UUID[] DEFAULT NULL;

-- Fast "is table X part of any open joined session?" membership checks
-- (needed by the open-session guard trigger below and by unjoin/join).
CREATE INDEX IF NOT EXISTS idx_sessions_joined_tables
  ON table_sessions USING GIN (joined_table_ids)
  WHERE status = 'open';

-- 2. Guard: a joined SECONDARY table must never get its own open session.
--    The uq_open_session unique index only protects table_sessions.table_id;
--    code paths that auto-open sessions by table label/QR (orderService,
--    qrService) look up table_sessions.table_id, find nothing for a joined
--    secondary table, and would silently open a competing session — which
--    would hijack tables.current_session_id and split the group's bill.
--    A BEFORE INSERT trigger closes that hole at the source of truth.
CREATE OR REPLACE FUNCTION guard_joined_table_open_session() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'open' AND EXISTS (
    SELECT 1 FROM table_sessions ts
     WHERE ts.business_id = NEW.business_id
       AND ts.status = 'open'
       AND ts.joined_table_ids @> ARRAY[NEW.table_id]
  ) THEN
    RAISE EXCEPTION 'Table is joined to another running session';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sessions_joined_guard ON table_sessions;
CREATE TRIGGER trg_sessions_joined_guard BEFORE INSERT ON table_sessions
  FOR EACH ROW EXECUTE FUNCTION guard_joined_table_open_session();
