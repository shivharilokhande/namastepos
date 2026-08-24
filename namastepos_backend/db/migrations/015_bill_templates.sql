-- NamastePOS migration 015 — Per-tenant bill template customization
-- Sprint 1 / Story FF-306.

CREATE TABLE IF NOT EXISTS bill_templates (
  business_id        UUID PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  logo_url           TEXT,
  header_lines       TEXT[],                       -- ["My Cafe", "Anjuna Beach Road, Goa"]
  gstin              VARCHAR(15),
  fssai_no           VARCHAR(20),
  footer_text        TEXT,                          -- "Thanks for visiting!"
  show_token         BOOLEAN NOT NULL DEFAULT TRUE,
  show_tax_breakdown BOOLEAN NOT NULL DEFAULT TRUE,
  paper_width_mm     INTEGER NOT NULL DEFAULT 80   CHECK (paper_width_mm IN (58, 80)),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_bill_templates_updated ON bill_templates;
CREATE TRIGGER trg_bill_templates_updated BEFORE UPDATE ON bill_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
