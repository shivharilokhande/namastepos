-- Migration 029 — Dead-stock view + heat-map indexes + menu-engineering metrics
-- Sprint 7 / FF-1104, FF-1105, FF-1106

-- Cached aggregates for "menu engineering" — refresh nightly
CREATE TABLE IF NOT EXISTS menu_metrics_daily (
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  menu_item_id    UUID NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  metric_date     DATE NOT NULL,
  units_sold      INTEGER NOT NULL DEFAULT 0,
  revenue_paise   BIGINT NOT NULL DEFAULT 0,
  food_cost_paise BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (business_id, menu_item_id, metric_date)
);
CREATE INDEX IF NOT EXISTS idx_menu_metrics_business_date
  ON menu_metrics_daily (business_id, metric_date DESC);

-- Heat-map: aggregate orders by hour of day + day of week
CREATE OR REPLACE VIEW vw_orders_by_hour AS
  SELECT
    business_id,
    EXTRACT(DOW FROM created_at)::int AS day_of_week,
    EXTRACT(HOUR FROM created_at)::int AS hour_of_day,
    COUNT(*)::int AS order_count,
    COALESCE(SUM(total), 0)::float AS revenue_inr
  FROM orders
  WHERE status <> 'cancelled'
  GROUP BY business_id, day_of_week, hour_of_day;

CREATE OR REPLACE VIEW vw_dead_stock AS
  SELECT
    mi.business_id,
    mi.id AS menu_item_id,
    mi.name,
    mi.category,
    mi.price,
    mi.stock,
    (SELECT MAX(o.created_at)
       FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE oi.menu_item_id = mi.id) AS last_sold_at
  FROM menu_items mi
  WHERE mi.is_active = TRUE;
