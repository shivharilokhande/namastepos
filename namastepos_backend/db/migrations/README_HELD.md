# Held migrations

`063_five_plans.sql.hold` and `064_plan_feature_ladder.sql.hold` are **intentionally held** (renamed from `.sql` so the migration runner skips them — it only applies `*.sql`).

They contain the **5-plan pricing rollout** (Growth ₹399, Enterprise ₹2999, and new Pro ₹799 / Advanced ₹1499 tiers + feature ladder). As of 2026-08-27 production still runs the original 3 plans (Starter ₹0 / Growth ₹299 / Enterprise ₹799) and the founder has chosen to **decide on the pricing change later**.

To roll them out later: rename both back to `.sql` (drop the `.hold`), decide how existing customers on old prices are handled, then deploy (Render runs `npm run migrate`). They are forward-only and idempotent.
