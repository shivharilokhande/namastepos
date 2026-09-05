---
tags: [namastepos, billing]
---
# Plans, Billing and Subscriptions

Live plans: Starter 15 keys / Growth 24 / Pro 34 / Advanced 45 / Enterprise 51 (`curl -s https://api.namastepos.in/v1/public/plans`). Limits (staff/floors/tables/menu_items/monthly_orders/businesses, `-1` = unlimited) live in `plans.limits` and are enforced by `subscriptionService.enforceLimit`, **not** by feature keys. Staff cap counts staff only, not the owner.

## `subscriptions.status` (Postgres enum `subscription_status`)
`trialing` (7 days, on a paid plan) · `active` · `past_due` (grace `PAST_DUE_GRACE_DAYS`) · `paused` (tenant churn-save) · `cancelled` · **`suspended`** (admin only, mig 094; tenant cannot undo). Only active / live trial / in-grace past_due are entitled.

## Rules (rewritten 2026-09-05 — see [[Code Review 2026-09-05]] A1–A6)
- Production **never** activates a paid plan without a Razorpay charge. `razorpayService.checkoutMode()` decides `gateway | manual | unavailable`; prod without live key + webhook secret → 503 `PAYMENTS_UNAVAILABLE`.
- `POST /billing/resume` only undoes `active + cancel_at_period_end`. Anything else → 409 `RESUME_NOT_ALLOWED`. Paid + gateway → returns a checkout; row flips `active` only in `_onChargeSuccess` (matched via `reactivation_rzp_subscription_id`).
- Downgrade to a ₹0 plan during a paid period = **scheduled**: mandate cancelled at cycle end, `pending_plan_id` set, features kept until period end, applied by webhook or the nightly `sweepPeriodEndTransitions()`.
- Pause cancels the mandate; resume of a paid plan returns a checkout and the row stays `paused` until the charge lands.
- Paid addon resume goes through checkout; expired → 409 `ADDON_EXPIRED_REBUY`. Expired addons stop granting features.
- Proration: computed only on the manual (non-gateway) path. Prod upgrades forfeit the remainder — **founder decision open**.
- Webhooks: HMAC on `req.rawBody`, dedup table, every status write clears the feature cache.

## Files
`subscriptionService.js`, `churnService.js`, `addonService.js`, `razorpayService.js`, `billingController.js`, `cronWorker.js`, migrations 002 (enum), 040 (per-plan features), 074 (addon grants), 087 (trial/grace), 094 (suspended + pending downgrade). Tests: `lifecycleBilling2026`, `addonResumeBilling2026`, `churnPrevention2026`, `razorpay_webhook2026`.
