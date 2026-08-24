# Day 1 status — 22 Aug 2026

Vikram → Shivhari. What got done, what's blocked on real infra, what's still on today.

## Green

- **Unit test suite** — 16 suites, 64 tests, all green (up from 15/58 after adding the new transition-matrix test). No regressions from the P0/P1 sweep. `npx jest --testPathIgnorePatterns=integration` in `foodflow_backend`.
- **Lint sweep on touched files** — auto-fix ran on the 14 files the P0/P1 sweep touched; remaining 76 warnings are pre-existing (mostly `global-require` inside conditional handlers in `staffService`), not from this sweep.
- **Transition-matrix regression test** — new `tests/unit/orderTransitions.test.js`. Locks the invariants: `cancelled` is terminal, no state rewinds to `pending`, `collected → cancelled` is the only refund path. This is the test that would have caught yesterday's "loyalty double-award" bug. `ORDER_TRANSITIONS` is now exported from `orderService`.
- **Gateway refund reconciler** — new `services/refundReconcileService.js`, wired into `cronWorker` every 5 ticks (~5 min). Picks up 25 oldest `status='pending'` refunds with a gateway payment method (`card` / `online`), calls Razorpay `/v1/payments/{pid}/refund`, flips to `processed` with the `razorpay_refund_id` stored. Transient failures (5xx / network) stay pending with an incrementing `attempt_count`; permanent 4xx go straight to `failed` with the reason. Rows with 12+ transient failures get `flagged_for_review=true` for support. Module loads cleanly (`node -e "require('./src/services/refundReconcileService')"`).
- **FCM client wire-up (client half)** — `AuthProvider._postLogin()` extracted and called from all five sign-in paths (Google, dev-email, register-password, login-password, PIN). Calls `NotificationService.instance.registerFcmToken(businessId)`, which is still a soft no-op until `firebase_messaging` is on the classpath. `pubspec.yaml` now has the two commented Firebase deps and the one-line uncomment activates the whole chain: no other code changes needed once the Firebase project is provisioned.

## Blocked on real infra (sandbox has no Postgres / no Flutter SDK)

- **Backend integration tests** — 14 suites `ECONNREFUSED :5432`. Need to run against staging DB.
- **IDOR audit script** (`scripts/idor-audit.js`) — requires two live owner accounts + running API. Same story.
- **Playwright dashboard / admin** — need the dashboard/admin dev servers up.
- **Flutter widget tests** — no `flutter` binary in the sandbox. `AuthProvider` + `SetupWizard` + `KDS` edits all read cleanly at the source level; real `flutter analyze` needs to run.

None of these are code changes — they're "spin the environment, hit the button". Slot these first on real infra Day 1 morning.

## Still on today (14:00–19:00 window)

- **FCM server side dry-run** — provision the Firebase project, drop `google-services.json`, uncomment the two lines in `pubspec.yaml` + the three lines in `notification_service.dart`, run one end-to-end push from `send_notification.js`. Est 2 hrs.
- Optional stretch: expand the transition-matrix test to cover the new `ORDER_TRANSITIONS[collected] === ['cancelled']` path via an integration test (needs DB).

## Day 2 preview

- P2 close-out (empty-state CTAs, Semantics labels, force-close-unpaid endpoint).
- k6 load test against the new advisory-lock path in `kotService.nextTicketNo` — I want to confirm the lock doesn't collapse p95 at 200 rps.

— V.

## File index (delta since the P0/P1 sweep)

```
foodflow_backend/
  src/services/refundReconcileService.js   NEW  (129 lines, gateway refund drainer)
  src/services/cronWorker.js               EDIT (imports + 5-min tick block)
  src/services/orderService.js             EDIT (export ORDER_TRANSITIONS)
  tests/unit/orderTransitions.test.js      NEW  (6 assertions, matrix invariants)

foodflow_flutter/
  lib/providers/auth_provider.dart         EDIT (import + _postLogin() in 5 paths)
  pubspec.yaml                             EDIT (firebase_core / firebase_messaging commented)
```
