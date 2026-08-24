-- Migration 022 — Online ordering site + WhatsApp ordering/marketing
-- Sprint 6 / FF-701, FF-702, FF-1004, FF-1005, FF-1003

CREATE TABLE IF NOT EXISTS site_settings (
  business_id     UUID PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  brand_slug      VARCHAR(60) UNIQUE,        -- mybar.namastepos.in
  hero_image_url  TEXT,
  primary_color   VARCHAR(7),
  brand_story     TEXT,
  contact_email   CITEXT,
  contact_phone   VARCHAR(20),
  address         TEXT,
  delivery_radius_km NUMERIC(5,2),
  min_order_paise INTEGER NOT NULL DEFAULT 0,
  delivery_fee_paise INTEGER NOT NULL DEFAULT 0,
  is_published    BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_site_updated ON site_settings;
CREATE TRIGGER trg_site_updated BEFORE UPDATE ON site_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- WhatsApp inbox (Twilio / Meta WA Business)
CREATE TABLE IF NOT EXISTS wa_threads (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_phone  VARCHAR(20) NOT NULL,
  customer_name   VARCHAR(255),
  state           VARCHAR(20) NOT NULL DEFAULT 'idle',  -- idle | menu | cart | confirming
  draft_cart      JSONB,
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_wa_thread UNIQUE (business_id, customer_phone)
);

CREATE TABLE IF NOT EXISTS wa_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  thread_id       UUID NOT NULL REFERENCES wa_threads(id) ON DELETE CASCADE,
  direction       VARCHAR(8) NOT NULL,   -- in | out
  body            TEXT,
  media_url       TEXT,
  provider_msg_id VARCHAR(80),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wa_msgs_thread
  ON wa_messages (thread_id, created_at DESC);

-- WhatsApp marketing campaigns + queued messages
CREATE TABLE IF NOT EXISTS wa_campaigns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name            VARCHAR(120) NOT NULL,
  template_body   TEXT NOT NULL,
  audience_filter JSONB,
  status          VARCHAR(20) NOT NULL DEFAULT 'draft',  -- draft | scheduled | running | done | cancelled
  scheduled_at    TIMESTAMPTZ,
  recipient_count INTEGER NOT NULL DEFAULT 0,
  sent_count      INTEGER NOT NULL DEFAULT 0,
  delivered_count INTEGER NOT NULL DEFAULT 0,
  created_by_user_id UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-greeting + birthday job queue
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id     UUID REFERENCES customers(id) ON DELETE CASCADE,
  channel         VARCHAR(20) NOT NULL,    -- sms | whatsapp | email
  kind            VARCHAR(40) NOT NULL,    -- birthday | anniversary | nps | reservation_reminder | token_ready
  scheduled_at    TIMESTAMPTZ NOT NULL,
  body            TEXT NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',
  sent_at         TIMESTAMPTZ,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_scheduled_msgs_due
  ON scheduled_messages (status, scheduled_at) WHERE status = 'pending';

-- Customer-facing review aggregation
CREATE TABLE IF NOT EXISTS reviews (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  source          VARCHAR(20) NOT NULL,     -- google | zomato | swiggy | namastepos_nps
  external_id     VARCHAR(120),
  rating          INTEGER CHECK (rating BETWEEN 1 AND 5),
  reviewer_name   VARCHAR(255),
  body            TEXT,
  reply           TEXT,
  reply_at        TIMESTAMPTZ,
  posted_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_review UNIQUE (business_id, source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_reviews_business_date
  ON reviews (business_id, posted_at DESC);

-- NPS feedback
CREATE TABLE IF NOT EXISTS nps_feedback (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id        UUID REFERENCES orders(id) ON DELETE SET NULL,
  customer_phone  VARCHAR(20),
  rating          INTEGER CHECK (rating BETWEEN 1 AND 10),
  comment         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Order tracker public link (FF-605)
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS tracker_token VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS uq_order_tracker
  ON orders (tracker_token) WHERE tracker_token IS NOT NULL;
