# Handover — 6 September 2026 (end of day)

State is **clean and shipped**: `8f96b87` is live in production (verify with
`curl -s https://api.namastepos.in/v1/health | jq -r .commit`; migrations 094–099 applied
on boot), CI green, APK **v1.0.23+24** on R2 (sha-verified; the public `r2.dev` URL is
edge-cached and may lag). Three rounds shipped today: `4b50e19` (review fixes), `8d4f6c9`
(built the sold-but-empty features, closed the review's open items), `8f96b87` (founder's
wallet/settle/membership/grievance bugs). Tests: backend **1080**, dashboard **62**
(vitest, new), Flutter **193**; eslint/tsc/build clean in all four packages and gated in CI.

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

## What the founder is likely to ask about first

- **"The commit failed"** — check `check-runs`, not the red ✗. Today the only red was
  `marketing-claims-live`: production's Enterprise plan has `voice_pos` back (he removed it
  on 5 Sep; something re-ticked it in Admin → Plans). The pinned feed was refreshed to match.
  Ask him whether that was intended.
- **"Code removed, only comments added"** — he raised this on `8d4f6c9`. Measured: +5,013
  code / +1,179 comment / −928 code lines; every large removal is a move into a shared module
  (`lib/rbac.ts`, `components/FeaturePicker.tsx`, `lib/featureLabels.ts`, `pages/AccountPage.tsx`,
  `lib/checkout.ts`, `utils/checkout_money.dart`). Offer terser comments if he asks again;
  the dated "why" style predates these sessions.
- **The wallet bug he reported** (points + wallet at Pay & place, Settle still due): root
  cause was server-side — sessions had no paid/due notion and `closeSession` sized the wallet
  draw against the whole session total (double debit). Fixed in `8f96b87`; he must install
  v1.0.23 to see the client side.

## Open items — `TRACKER.html` is the live list

**Needs him:** install v1.0.23 and re-run his flow on phone + web; proration-on-upgrade
decision (plumbing exists: `createSubscription({ startAt: current_period_end })`, needs a
Razorpay test-mode run); open Admin → Operations → Review checks (his prod SQL is a page
now); confirm whether `voice_pos` on Enterprise is intended; may cashiers take wallet
top-ups; plus the older items (GSP/IRP creds, `DB_SSL_VERIFY`, Voice POS device test,
iOS print taps).

**Needs us:** admin console has no unit-test runner (dashboard got vitest today); wire
proration once approved; `ORDER_TAX_ENFORCE` → `enforce` on Render after a week of `log`.

## Traps (details in the vault)

- **Tier codes**: `pro` = Enterprise, `basic` = Growth. Gate on feature keys only.
- **`| tail` swallows exit codes.** Capture to a file, check `$?`.
- **`marketing-claims-live` red ✗ is not a failure** — check `check-runs`, not `gh run list`;
  when red it means plans were edited in super-admin: refresh `tests/fixtures/plan-feed.json`.
- **Omitted `tax` ≠ `tax: 0`** in `POST /orders` — omitted means server computes GST;
  tests that want tax-free arithmetic say `tax: 0` explicitly.
- **Don't run two jest processes on the shared test DB** (`resetDb`); and don't run the
  full backend suite while Flutter/dashboard builds are running — a `socket hang up` flake
  appeared under that load (`membership_crud`, 3/3 green alone).
- **Founder's shell exports `NODE_ENV=production`** — vitest config pins `NODE_ENV=test`
  or React's production build makes every component test fail with "act(...) not supported".
- **Artifact publish is impossible from a Cowork non-interactive session.** Files in repo.
- **Settle = balance, not total.** Any new settle/split code must use `duePaise`.

## Verify anything

```
curl -s https://api.namastepos.in/v1/health | jq -r .commit
```
