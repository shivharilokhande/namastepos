# Handover — 6 September 2026

State is **clean and shipped**: `4b50e19` is live in production (`/v1/health` → commit
`4b50e19`, db ok, migration 094 applied), CI green on the required jobs, APK v1.0.22+23
byte-exact on R2 (the public `r2.dev` URL is edge-cached and may serve the old bytes for
a while). This session's docs commit follows.

**Start with `docs/vault/00 Start Here.md`** — a linked knowledge vault (architecture,
registry/gating, billing rules, GST, tier-code trap, dev loop, deploy, founder rules).
It replaces most of what used to live only in this file.

---

## What happened this session

The in-depth `/engineering:code-review` the founder asked for **was actually run**:
five read-only reviewers (backend entitlements, backend correctness, admin, dashboard,
mobile), then five fixers with strict file ownership, then a full gate run, one commit,
deploy verification, APK build + upload.

- 62 findings, 8 P0, 22 P1 → 52 fixed and live. Report: `CODE_REVIEW_2026-09-05.html`.
  Raw reviewer/fixer reports with file:line evidence: `docs/review-2026-09-05/`.
- Backend tests 828 → **943**, Flutter 92 → **131**, eslint 0 errors, registry audit OK,
  dashboard now has an eslint config and a CI lint step.
- Answers to his four questions are at the top of the report. Short form: money and GST
  had real P0 bugs (now fixed); admin exposes every key; mobile gating was sound, dashboard
  gating was a lock icon (now real); six server gate rules matched no route (now real, and
  a router-walking test fails CI on any dead rule).

## Standing instructions from the founder (unchanged)

- **Keep the MacBook awake**: `nohup caffeinate -dimsu &` — every session, every prompt.
  Check `pgrep -x caffeinate` first.
- **Show visible progress** — task list + say what is happening. He is watching cost.
- **He does all logins, payments, OTP/2FA, CAPTCHAs.** Never type credentials.
- Concise, direct. Verify against live code / API / a gate run before saying "done".

## Traps (details in the vault)

- **Tier codes**: `pro` = Enterprise, `basic` = Growth. Gate on feature keys only.
- **`| tail` swallows exit codes.** Capture to a file, check `$?`.
- **`marketing-claims-live` red ✗ is not a failure** — check `check-runs`, not `gh run list`.
- **Omitted `tax` ≠ `tax: 0`** in `POST /orders` since this session — omitted means server
  computes GST from the menu. Tests that want tax-free arithmetic say `tax: 0` explicitly.
- **Don't run two jest processes on the shared test DB** — some suites `resetDb()`.
- **Artifact publish is impossible from a Cowork non-interactive session** (approval card).
  Both TRACKER.html and the review are files in the repo root instead.

## Open items — `TRACKER.html` is the live list

**Needs him (decisions / prod checks):** install v1.0.22 and bill one item on phone and
web (GST rows should appear); pull `recurring_invoices` (+ `api_access`, `white_label`,
`marketplace_addons`) from plan cards or ask for a build; count already-issued ₹0-GST
invoices; check tenants with aggregator credentials but no `aggregators` key (webhook
orders are now parked); read-only check of lapsed cancel-at-period-end rows before the
first nightly sweep; three billing policy decisions (proration on upgrade, suspended
tenants' mandate, paid-addon cancel timing); B2B template save key; inventory web vs
mobile gating. Plus the earlier items: GSP/IRP credentials, stub-IRN count, `DB_SSL_VERIFY`,
Voice POS on-device test, iOS print taps.

**Needs us (next session):**
1. Mobile order lines don't send `variantId`/`modifierLines` — server re-prices to base
   (pre-existing P1, found by the mobile fixer). Needs `OrderItem` + body + sqflite.
2. `requireStaffPerm` on `POST /orders`, cancel-collected, session open, customers — exact
   lines in `docs/review-2026-09-05/fix_BE-C.md`; confirm the role matrix with him first.
3. B2B invoice template backend store (blocked on his answer).
4. Dashboard vitest; admin eslint config; admin "effective features per customer" view;
   "Offer yearly" toggle is a no-op (`serializePlan` always returns 10× monthly).
5. `ORDER_TAX_ENFORCE` → `enforce` on Render once a week of `log` looks clean.

## Verify anything

```
curl -s https://api.namastepos.in/v1/health | jq -r .commit
```
