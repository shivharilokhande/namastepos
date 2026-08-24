# CTO memo — Vikram Iyer → Shivhari (founder)

**Date:** 22 Aug 2026 · 21:40 IST  
**Subject:** Post-sweep status + recommended next 72 hours to launch  
**From:** Vikram Iyer, CTO  
**To:** Shivhari (founder), the two engineers on rotation, ops lead

---

Shiv — the P0/P1/P2 sweep you asked for is done. Here's the honest state of the tree and what we should do between now and Monday morning to launch cleanly.

## What just shipped (this sweep)

**All 9 P0s — closed.** These were the "customers will hate us in week 1" bugs.

1. `orderService.js` — `const tax` reassignment TypeError killed every order create the moment the caller didn't pass `tax`. Now `let`.
2. `revenueLeakageService.js` — was querying `payment_method='comp'` (not in the enum) → every leakage report threw 22P02. Filter dropped; kept the 100%-discount signal.
3. Report services — `created_at::date` bucketed everything in UTC, so a 11:40 PM IST order landed on the next day. Wrapped in `AT TIME ZONE 'Asia/Kolkata'` across `dailyClosingService`, `incomeStatementService`, `reportService`, `revenueLeakageService`.
4. `billSplitService.paySplit` — cross-tenant IDOR. Added tenant guard via `bill_splits.business_id` subquery.
5. `discountApprovalService` — threshold key was global (`order.discount_approval_threshold_inr`). Now per-tenant.
6. `finalSprint.routes.js` — any owner could overwrite global FX rates. Now `403 FX_WRITE_SUPERADMIN_ONLY`.
7. `aggregatorService.processIncomingOrder` — passed placeholder UUID `00…00` when an item didn't map → FK violation → 500 on Zomato webhook. Now `null` + calls `mappingIssuesService.recordUnmappedBatch`.
8. `staffService.verifyPin` — no rate-limit; six-digit PIN was trivially brute-forceable. Added in-memory attempt counter, 5 tries / 15 min window.
9. POS confirm screen — the spinner locked when print or WhatsApp threw. Wrapped in try/catch/finally with humanised snackbar.

**All 8 P1s — closed.**

- `refundService.refundOrder` — was capped only against order total in isolation; the same order could be refunded to infinity. Now sums prior refunds (`pending`/`processed`/`succeeded`) and rejects if new + prior > total. Cash/UPI is auto-marked `processed`; gateway path stays `pending` (worker TODO logged).
- `orderService.updateStatus` — no state machine, so a cancelled order could be flipped back to `pending`. Added `ORDER_TRANSITIONS` matrix.
- `driverService.markStatus('delivered')` — never propagated to the parent order. Now flips `orders.status = 'collected'` in the same call.
- `aggregatorWebhooks.routes` — `recordWebhookOutcome` never fired, so the FF-245 sync badges froze. Now called on both success and failure paths.
- `kotService.nextTicketNo` — `MAX+1` without `FOR UPDATE`; two concurrent orders could pick the same ticket. Now guarded by `pg_advisory_xact_lock` keyed on business_id.
- Setup wizard (`setup_wizard_screen.dart`) — `TextEditingController(text: …)` was created inside `build()`, so every keystroke lost the caret. Hoisted to the row models, disposed in `dispose()`.
- POS printer — errors were `debugPrint`-only, owners had no idea why the KOT never came out. Now snackbars on failure, dialog shows the humanised error, retry-print also surfaces failures.
- `api_service.listOrders` — mobile silently capped at 100. Busy lunch service loses everything after the 100th. Bumped default limit to 1000 with `offset` passthrough.

**P2s — one shipped, three deferred to Day 3 (see plan below).**

- KDS ticket header now shows `LATE / HOT / SOON / OK` text next to the border colour. Colour-blind kitchen staff and printed KDS boards can now read state without perceiving hue.

Deferred P2s (still tracked): empty-state CTAs on Inventory / Customers / Reviews, Semantics labels on the custom widgets, super-admin "force close session as unpaid" endpoint + UI.

## What's still in the risk column

- FCM client wiring — server side is live, but `notification_service.registerFcmToken` is still a no-op stub until we add `firebase_messaging` + `google-services.json`. Owners won't receive push. Instructions are in-file. **Estimate: 2 hrs once we have the Firebase project.**
- Gateway refund worker — pending refunds against `razorpay/card/online` sit forever. We should either enqueue the Razorpay call from `refundOrder` or add a nightly reconciler. Cash/UPI is fine.
- The three deferred P2s above.
- We haven't run the Playwright + widget suites since the sweep. I want a full green board before Prod push.

## Recommended next 72 hours

### Day 1 — Mon 25 Aug (regression + wire-up)
- **09:00–11:00** — Full Jest backend suite + fix any breakage from the transition matrix + advisory lock. Rerun the IDOR audit script.
- **11:00–13:00** — Playwright dashboard + admin, Flutter widget tests. Any red = block launch.
- **14:00–17:00** — FCM client wire-up. Provision the Firebase project, add `google-services.json`, drop the `firebase_messaging` dep, hook `AuthProvider.postLogin` to call `registerFcmToken`.
- **17:00–19:00** — Gateway refund worker (BullMQ + retry with backoff) OR a nightly cron reconciler — engineer to pick. I'd take the cron; it's one file and one migration.

### Day 2 — Tue 26 Aug (polish + P2 close-out)
- **09:00–12:00** — Empty-state CTAs on Inventory, Customers, Reviews. Copy is written; it's a paste job.
- **12:00–14:00** — Semantics labels on `PlanGate`, `HomeBottomNav`, KOT card, order tile. This is TalkBack support, and Google Play reviews will call it out if we ship without.
- **14:00–17:00** — Super-admin `POST /admin/sessions/:id/force-close-unpaid` endpoint + row in dashboard's Admin panel. Records the loss into `revenue_leakage_events` with reason='walkout'.
- **17:00–19:00** — Load test with k6 against the fixed order path (advisory-lock is the new hot section). Confirm p95 latency ≤ 250 ms at 200 rps.

### Day 3 — Wed 27 Aug (launch dress rehearsal)
- **09:00–11:00** — Migration bundle: verify `refunds.order_id`, `plan_features`, `bill_splits.business_id` are all applied on staging, then dry-run against a prod snapshot.
- **11:00–13:00** — End-to-end walkthrough on real hardware: Android tablet at the counter, thermal printer live, Razorpay in test mode. Two owners on the call, they order, cancel, refund, split-pay, aggregator webhook.
- **14:00–16:00** — Sentry double-check. Confirm PII scrubbing is intact (we changed error humanizer), confirm cookie flags on the prod domain.
- **16:00–17:00** — Sign-off call. Go / no-go for **Thu 28 Aug 06:00 IST** launch window (before café breakfast rush).
- **17:00 onwards** — On-call rota. I'm primary, you're secondary, both engineers rolling shift for 48h post-launch.

## What I'd say no to right now

- Bulk edit menu (FF-327), multi-language guest QR (FF-337), bulk edit orders (FF-338), admin Crisp bridge (FF-339), Menu Engineering + NPS report pages (FF-324), feature-flag admin page (FF-325). These are all in the backlog and none of them keeps a café from taking money on Thursday morning. Ship after launch when we have production load telling us what to build next.

That's the plan. Push back on anything you disagree with — I'd rather argue tonight than un-ship on Friday.

— Vikram
