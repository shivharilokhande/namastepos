# Handover — 5 September 2026

Written at the end of a long session. State is **clean and shipped**: working tree
has nothing uncommitted, CI is green, and `88c693d` is verified live in production.

---

## Read this first: what was NOT done

**The in-depth code review the founder asked for was never started.**

He asked for a full `/engineering:code-review` across the codebase, answering four
questions:

1. Is everything that was developed actually working, or are there bugs?
2. Are all features present in admin as features that can be added to plans?
3. Are all features working in admin, dashboard and mobile?
4. Do features activate/deactivate correctly per plan in dashboard and mobile?

Tasks #45–#48 were created and marked `in_progress`, **but no review agent was ever
dispatched and no review work happened.** The task board is misleading on this point.
Reset those tasks to `pending` and actually run it.

He also asked to be shown continuous progress, because — his words — work had been
disappearing into "working on it" with nothing to show. Use the task list actively
and report findings as they land, not only at the end.

---

## Standing instructions from the founder

- **Keep the MacBook awake** while work is running: `nohup caffeinate -dimsu &`.
  It is currently **stopped** — restart it before any long run.
- **Show visible progress.** Task list in_progress/completed, and say what is
  happening. He is watching cost and has said so directly.
- **He does all logins, payments, OTP/2FA, CAPTCHAs.** Never type credentials.
- Concise, direct. Report outcomes, not steps.
- Verify against live code / live API / a gate run before saying something is done.

---

## Where things stand

| | |
|---|---|
| HEAD | `88c693d` — clean tree, pushed |
| Production API | `88c693d` live (verified) |
| CI | green, last 3 runs |
| App | v1.0.21+22 — APK on R2 byte-exact, installed on his iPhone |
| Backend tests | 828/828 |
| Flutter tests | 92/92 |
| Lint | 0 errors (190 pre-existing warnings — baseline, do not "fix") |
| Repo size | 1.3 GB (was 6.1 GB) |

**Verify any deploy with one command** — this is new today and replaces logging
into the Render dashboard:

```
curl -s https://api.namastepos.in/v1/health | jq -r .commit
```

---

## Traps that will bite you

**The tier-code trap — the single most dangerous thing in this codebase.**
`plans.tier` codes are `free`=Starter, `basic`=Growth, `pro_plan`=Pro,
`advanced`=Advanced, and **`pro`=ENTERPRISE**. `src/config/planTiers.js` is the only
source of truth. Never gate on a tier code — gate on the feature key.

**The red ✗ that is not a failure.** `marketing-claims-live` is
`continue-on-error: true`, so the *run* goes green while GitHub still paints a red
cross on the commit. The founder has asked about this **three times**, reading it as
"the commit failed". When he asks, check
`gh api repos/:owner/:repo/commits/<sha>/check-runs` rather than `gh run list` —
they disagree by design.

That job going red is usually **real and useful**: it means he edited plans in the
super-admin console and `tests/fixtures/plan-feed.json` no longer matches
production. The fix is to refresh the pin *and* re-check the copy in the same
commit (the job's own error message says how). That is exactly what happened today
when he removed `voice_pos` from Enterprise.

**Never let `| tail` swallow an exit code.** A commit went out today with a failing
test because `npx jest ... | tail -5` reports tail's status. Capture to a file and
check `$?`.

**`graphify-out/` is now gitignored** and stays on disk. A commit hook regenerates
it; tracking it kept 33 files permanently dirty and put ~36k lines of generated
diff into ordinary commits.

---

## What shipped today (7 commits)

- **E-invoice was fabricating IRNs in production.** `generateIrn()` computed a
  correct NIC hash and never called the IRP — every IRN in production was fake, on
  a feature Advanced sells at ₹999. Production now refuses; non-prod emits
  `DEMO-NOT-A-VALID-IRN-…`. Migration 093 also created columns migration 046 only
  *thought* it created, so `POST /eway-bills` had been a 500 everywhere.
- **Audit trail was fire-and-forget** — the client was told an action succeeded
  while its audit row was still in flight. Now committed before acknowledgement.
- **14 fail-open entitlement gates**, including memberships gated on the *wrong key*
  (`loyalty` while the server enforces `memberships`). Root cause:
  `PlanInfo.starterDefault()` pre-granted 10 keys before the server answered. Now
  `PlanInfo.unknown()` — unloaded, failed fetch and absent key all deny.
- **One feature registry** (`src/config/featureRegistry.js`) drives the admin
  picker; a drift test fails CI when backend/admin/mobile disagree.
- **Entitlement staleness ~7 min → ~5–10s** on an active till, by reading the
  `X-Plan-Version` header the server was already sending and nobody read. The
  5-minute poll stays as backstop.
- **Deploys became verifiable** (`/v1/health` reports commit/branch/uptime).
- **Voice POS**: re-enabled, then IDF-weighted matching after he reported
  "amul pavbhaji" → Kolhapuri Pav Bhaji; then ~180 stopwords and ~105
  transliteration groups (alu/aloo, gobi/gobhi).
- **iOS stopped offering a Bluetooth printer flow Apple blocks**; offers
  AirPrint / share-to-PDF instead.
- **Test suite was exhausting Postgres** (90 of 100 connections, monotonic). Fixed
  at the harness level; peak is now 7 and independent of suite count.

---

## Open items

`TRACKER.html` in the repo root is the live list — open it in a browser, ticks are
saved locally. Currently **6 need him, 1 needs us, 3 known limits, 10 fixed**.

### Needs him (cannot be done for him)

1. **GSP / IRP credentials.** Until these exist, e-invoice and e-way bill cannot
   file. Production refusing is correct behaviour but is not the feature.
2. **Run the stub-IRN row count on production** — query is in migration 093's
   header. This is the highest-urgency item on the list: if any customer filed a
   return against a fabricated IRN, that is a tax problem with a clock on it.
3. **Check `DB_SSL_VERIFY` on Render.** `db.js` falls through to
   `rejectUnauthorized:false` unless it or `PG_CA_CERT` is set.
4. **Re-test Voice POS on the phone** — the rebuilt matching has never been spoken
   to on a real device, only unit-tested.
5. **Tap the iOS print buttons once.**
6. **Confirm Voice POS is gone for the Enterprise customer** (Mumbai Pavbhaji and
   Pulao). Propagation is seconds on an active till, ~7 min on an idle one.

### Needs us

- Publishing `TRACKER.html` as a shareable live page. The Artifact publish needs an
  approval card that could not be shown in a non-interactive session; retrying in an
  interactive one should work.

### Known limits (by design, not bugs)

- Voice gating is a **UI decision, not a security boundary** — recognition runs
  on-device, so there is no request to reject. Every other gate sits in front of a
  route `featureGate.js` already enforces.
- Mixed Hindi/English recognition is unreliable; default locale is `en_IN` because
  Devanagari output cannot match Latin-script menu rows. Nothing reaches the cart
  without a tap.
- Entitlement changes are ~5–10s on an active till, ~7 min on an idle one.

---

## Memory files worth reading

`project_namastepos_feature_registry_2026-09-05` covers the registry, fail-closed
gating, propagation timing and the voice matching model. The `MEMORY.md` index has
the rest — the RBAC, money/GST and Render deploy notes are the ones most likely to
save a wrong assumption.
