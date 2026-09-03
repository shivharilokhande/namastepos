# ADR-001 — Unify money on integer paise

- **Status:** Accepted (plan approved NP-144, 2026-09-03) — implementation not started
- **Deciders:** backend team, founder
- **Context date:** 2026-09-03, surveyed at branch `hardening/sprint-4`

This is a **planning document**. No code or schema changes ship with it.

## 1. Context — two money conventions coexist today

The schema grew in two eras. Everything added after ~migration 004 stores
money as **integer paise** (`*_paise`, INTEGER/BIGINT); the founding tables
from `001_init_schema.sql` (and a few later stragglers) store **NUMERIC(10,2)
rupees**. JS then bridges the two with `parseFloat`, `toFixed(2)` and a local
`round2()` — each bridge a rounding bug waiting to happen (we already shipped
one: order totals drifting a sub-paise, patched by `round2`, commit 3469003).

### 1.1 NUMERIC rupee columns (the legacy island)

From `db/migrations/*.sql` (table.column, all `NUMERIC(10,2)` unless noted):

**Order flow (hot path — the core of the problem):**
- `orders.subtotal`, `orders.tax`, `orders.discount`, `orders.total` (001)
- `orders.cgst`, `orders.sgst`, `orders.igst` (017)
- `order_items.price` (001), `order_items.gst_amount` (017)
- `guest_sessions.total_inr` (007)

**Catalog / pricing:**
- `menu_items.price`, `menu_items.cost_price` (001)
- `menu_item_variants.price`, `menu_item_variants.cost_price` (013)
- `modifiers.price_delta_inr` (013)
- `franchise_prices.price` (025)

**Money-adjacent aggregates & misc:**
- `expenses.amount` (001)
- `customers.total_spent` (001, NUMERIC(12,2))
- `inventory_transactions.balance_after` (001; unit-cost context)
- `coupons.value` (003; overloaded: percent OR ₹ OR days), `coupons.min_basket_inr`
  (048), `coupons.max_discount_inr` (058)
- `business_users.monthly_salary_inr` (048)
- `membership_redemptions.value_inr` (055)

### 1.2 Integer-paise columns (the target convention, already dominant)

49 distinct `*_paise` columns across ~45 tables, including all money added
since: `payments`, `refunds`, `invoices` + `invoice_line_items`,
`tax_invoices`, `gift_cards` (`balance_paise`), `wallet_ledger` /
`customer_wallets` / `customers.wallet_balance_paise`, `tips`, `plans`
(`price_paise`, `price_yearly_paise`), `memberships`/`membership_subscriptions`,
`bill_splits`, `delivery_zones`/`delivery_assignments`, `discount_approvals`,
retail (`retail_items.mrp_paise`, `unit_cost_paise`, PO/quotation lines),
ledger/journal lines, `daily_metrics`, `revenue_leakage_events`, etc.

**Crucially, `orders` itself is already mixed:** `loyalty_discount_paise`
(005), `food_cost_paise` (008), `service_charge_paise`, `round_off_paise`
(014), `tip_paise` (020→BIGINT in 046) sit next to the NUMERIC
`subtotal/tax/discount/total`. One row, two currencies of representation.

### 1.3 The JS bridge layer (danger inventory)

Counts in `src/` at survey time: **191 `parseFloat`**, **53 `toFixed(`**,
**10 `round2`** references. There is **no shared money util** —
`src/utils/` has no money module; `round2` is a one-liner private to
orderService (`src/services/orderService.js:22`).

`round2()` call sites (all in the order bill math):
`orderService.js:313, 403, 409, 413, 416, 417, 419, 494`.

Heaviest `parseFloat` files (count): `controllers/guestController.js` (17),
`services/orderService.js` (16), `tableService.js` (14), `reportService.js`
(13), `detailReportsService.js` (13), `incomeStatementService.js` (12),
`recipeService.js` (11), `menuService.js` (8), `taxInvoiceService.js` (7),
`refundService.js` (7), `ingredientService.js` (7), `giftCardService.js` (6),
`aggregatorService.js` (6).

Heaviest `toFixed(` files: `printerService.js` (9), `gstrExportService.js`
(8, e.g. lines 85–88/101–103 — statutory GSTR CSV output), `gstService2.js`
(6), `giftCardService.js` (6), `utils/tokenPrinter.js` (3),
`orderService.js` (3, incl. the paymentBreakdown mismatch message at 972–973
and the WhatsApp bill message at 1664 which does
`parseFloat(order.total).toFixed(2)`).

### 1.4 Report queries that SUM the NUMERIC columns

Every one of these reads changes meaning when the source of truth moves to
paise (each must divide by 100 or switch to the shadow column):

- `controllers/guestController.js:413, 467` — `SUM(o.total)` per table session
- `services/billSplitService.js:21` — `SUM(total)` of a session's orders
- `services/ownerDigestService.js:21, 100` — daily/weekly revenue digests
- `services/revenueLeakageService.js:44, 62, 79` — `SUM(o.total/discount/subtotal)`
- `services/adminService.js:43, 140` — per-tenant GMV
- `services/incomeStatementService.js:93–94, 118–119, 344` — P&L taxable/gross
- `services/dailyClosingService.js:12, 19, 28, 36` — Z-report gross/by-tender/lost/discounts
- `services/platformReportsService.js:150` — platform GMV
- `services/tableService.js:511, 556` — table/session totals
- `services/reportService.js:48, 88` — sales by source / by tender
- plus `refundService.js`, `multiOutletService.js` (same pattern)

### 1.5 Client expectations (why we cannot flip responses)

- The **Flutter app** (fielded APKs/TestFlight builds through 1.0.10+11) and
  the **web dashboard** parse order/menu money as **INR floats** (`price: 20`,
  `total: 236.5`). The offline outbox stores INR amounts and replays order
  creates — old queued orders will arrive in INR long after any server flip.
- The **public landing page** renders plan pricing from `/v1/public/plans`
  (already paise-based — `price_paise` — so unaffected).
- **GSTR/Tally/Zoho exports and printed bills** must keep two-decimal INR
  formatting forever; they are presentation, not storage.
- Aggregator webhooks (Zomato/Swiggy payloads) deliver rupee floats; the
  webhook edge converts.

**Consequence:** API request/response shapes keep INR decimals until a
versioned API change well after phase 4. This ADR unifies *storage and
arithmetic*, not wire formats.

## 2. Decision

1. **Target: integer paise everywhere.** Every money value is stored in
   BIGINT paise columns and computed in JS as an integer number of paise.
   (JS integers are exact to 2^53 — ~₹90 trillion — so BIGINT-as-Number is
   safe for any realistic amount; keep `pg` default string parsing for BIGINT
   and convert at one boundary.)
2. **One money util.** New `src/utils/money.js` becomes the only place that
   converts: `toPaise(inr)` (validates + `Math.round(inr * 100)`),
   `toInr(paise)` (`paise / 100`), `formatInr(paise)` (two-decimal string for
   printing/exports), `addPaise/mulPaise` helpers. All new code imports it;
   existing `parseFloat`/`toFixed`/`round2` call sites are burned down against
   the §1.3 inventory (tracked as a checklist, file by file).
3. **New columns are paise-only.** Effective immediately (already noted in
   `db/migrations/MIGRATIONS.md`): any new money column is `BIGINT` with a
   `_paise` suffix. No new NUMERIC money.

## 3. Migration plan — staged, additive-only

House rule: no DB drops, forward-only migrations. Every phase is
independently shippable and independently revertible.

### Phase 1 — shadow columns + backfill + sync triggers (schema only)

Additive migration (next free number):

- `orders`: add `subtotal_paise, tax_paise, discount_paise, total_paise,
  cgst_paise, sgst_paise, igst_paise` — BIGINT NULL (NULL = "not yet
  backfilled"; no DEFAULT 0, so backfill progress is observable).
- `order_items`: add `price_paise, gst_amount_paise` BIGINT NULL.
- Backfill in batches (script, not one giant UPDATE — orders is the largest
  table): `SET total_paise = ROUND(total * 100)` etc., keyed by id ranges.
- `BEFORE INSERT OR UPDATE` trigger on both tables keeps the pair coherent
  whichever side was written: if the NUMERIC side changed and paise is
  NULL/stale → recompute paise; if only paise changed → recompute NUMERIC.
  ROUND half-up matches JS `Math.round` for positive amounts; `round_off_paise`
  can be negative — triggers must use `ROUND()` (half away from zero), which
  matches, and a comment pins this.
- Same treatment later (own migrations, same pattern) for the smaller NUMERIC
  islands: `menu_items.price/cost_price`, `menu_item_variants.*`,
  `modifiers.price_delta_inr`, `expenses.amount`, `guest_sessions.total_inr`,
  `coupons.min_basket_inr/max_discount_inr`, `customers.total_spent`,
  `membership_redemptions.value_inr`, `business_users.monthly_salary_inr`,
  `franchise_prices.price`. (`coupons.value` needs a design pass first — it is
  semantically overloaded: percent, ₹, or days.)

Verification gate: `COUNT(*) WHERE total_paise IS NULL` = 0 and a checksum
query `SUM(ABS(total_paise - ROUND(total*100)))` = 0 before phase 2.

### Phase 2 — dual-write from services

- `orderService` create/update/settle paths compute the bill **in paise**
  (INR inputs converted once at the validation boundary via `money.toPaise`)
  and write BOTH column families explicitly; the phase-1 trigger becomes a
  safety net, not the mechanism.
- Same for the smaller islands' services (`menuService`, `expenseService`,
  guest checkout, coupons).
- `round2()` becomes dead once bill math is integer; delete it at the end of
  this phase. The §1.3 checklist is worked file-by-file here.
- Tests: golden-bill fixtures asserting NUMERIC and paise columns agree for
  GST-inclusive, GST-exclusive, service-charge, split-tender, refund and
  round-off cases.

### Phase 3 — read-switch behind an env flag

- Env-gated (`MONEY_READ_PAISE=true`, default **false**; env-only config per
  house rules, wired through `src/config/env.js` like `REVENUE_INTEGRITY_CRON`).
- Every §1.4 report query gets a paise variant (`SUM(total_paise)` … `/100.0`
  at the presentation edge); the flag picks the code path. Responses stay
  INR-decimal — only the *source* column changes.
- Roll out: staging → prod with the flag on for a canary period; a nightly
  cron assertion (piggyback on the NP-121 revenue-integrity sweep) compares
  flag-on vs flag-off aggregates for the previous day and alerts on any
  paisa of drift.

### Phase 4 — stop writing NUMERIC (columns kept, never dropped)

- Remove NUMERIC writes from services; drop the phase-1 triggers; flip the
  flag default to true and, after a full billing cycle, remove the flag and
  the legacy read paths.
- The NUMERIC columns **remain in the schema permanently** (house rule: no
  drops). A final migration comments them
  (`COMMENT ON COLUMN orders.total IS 'FROZEN <date>: read/write total_paise'`)
  and, where safe, adds no further constraints — they simply stop changing.
- Mobile/web note: fielded apps keep receiving INR decimals computed from
  paise. Any future paise-native API is a separate, versioned decision.

## 4. Consequences

**Positive**
- One arithmetic domain: integer paise end-to-end kills the float-drift bug
  class (`0.1 + 0.2`, `parseFloat` of NUMERIC strings, double-rounding between
  bill lines and totals).
- Reports, GST exports and the ledger tables finally agree by construction —
  today `payments`/`refunds`/`invoices` (paise) are reconciled against
  `orders` (NUMERIC) through floats.
- New-code path is simple: one util, one suffix convention, enforced by review
  + MIGRATIONS.md.

**Negative / risks**
- Long dual-write window: more storage, slightly slower order writes
  (one trigger), and two columns that can theoretically disagree — mitigated
  by the checksum gates and the nightly drift assertion.
- The §1.3 burn-down is wide (191 parseFloat sites); phases 2–3 are the bulk
  of the cost. Estimate: the order flow files first, report files second,
  long-tail last.
- Trigger-based sync must be written carefully for negative amounts
  (`round_off_paise`, modifier deltas) and for direct-SQL writers (cron
  self-heals, scripts) — the trigger covers those by design.
- `orderService.js` is the hottest file and is deliberately **not** split
  first (deferred in NP-145 / MIGRATIONS.md); the paise rewrite of its bill
  math should land as small reviewed slices, not alongside a structural split.

**Rollback per phase**
- Phase 1: shadow columns + triggers are inert to all existing reads; rollback
  = drop the triggers (columns stay, unused — additive rule intact).
- Phase 2: rollback = revert the service commit; the phase-1 trigger resumes
  deriving paise from NUMERIC writes, so data stays coherent.
- Phase 3: rollback = flip `MONEY_READ_PAISE=false` (no deploy needed).
- Phase 4: rollback = re-enable dual-write (services still contain the write
  path until the cleanup commit) and flip the flag off; because NUMERIC
  columns were frozen, a catch-up backfill from paise → NUMERIC restores them
  exactly (paise is the finer-grained side, so this direction is lossless).

## 5. References

- `db/migrations/001_init_schema.sql`, `017_gst_item_slabs.sql` (NUMERIC core)
- `db/migrations/005/008/014/020/046` (paise columns already on `orders`)
- `src/services/orderService.js:22` (`round2`), commit 3469003 (paise rounding fix)
- `db/migrations/MIGRATIONS.md` (numbering + additive-only policy)
- Sprint-2 "Money Truth & Trust" (NP-111..121) — reconciliation groundwork
