# FoodFlow — Deploy-Ready Punchlist

**Date:** 22 Aug 2026 · **Owner:** Shivhari · **Launch mode:** Beta APK now → Play Store in 2 days

Answers to your six questions, in the order you asked. Each block ends with **what I need from you** so you know exactly what unblocks the next step.

---

## 1. What's required for deployment (APK path)

### Backend
| Item | Status | Action |
|---|---|---|
| Node.js server | ✅ Code ready | Deploy to Oracle Cloud Mumbai (free) or DO Bangalore (₹500/mo) |
| Postgres 15 | ✅ Schema ready | Same host, or Oracle Autonomous DB free tier |
| Environment vars | ⚠️ Need values | Fill `.env` from `foodflow_backend/.env.production.example` (see checklist below) |
| Domain + SSL | ⚠️ Need domain | `foodflow.in` registered → point A record → Cloudflare SSL |
| Migrations 001-054 | ⚠️ Run once | `npm run migrate` on the server |
| Cron worker | ✅ In-process | Boots with server via `cronWorker.start()` |
| Sentry DSN | ⚠️ Need project | Create Sentry project → paste DSN into `SENTRY_DSN` |

### Android APK
| Item | Status | Action |
|---|---|---|
| Flutter build config | ✅ Ready | `flutter build apk --release` on your machine |
| Signing keystore | ⚠️ Need to create | `keytool -genkey -v -keystore foodflow-release.jks …` — keep this file safe forever |
| `key.properties` file | ⚠️ Need to create | Points `android/key.properties` at the keystore + password |
| Backend URL | ⚠️ One-line change | In `lib/config/env.dart`, set `API_BASE` to your prod URL |
| `google-services.json` | ⚠️ Need Firebase project | See §2 |
| APK file to distribute | ⚠️ Build | Output at `foodflow_flutter/build/app/outputs/apk/release/app-release.apk` |

### Web (dashboard + admin + landing)
| Item | Status | Action |
|---|---|---|
| Dashboard build | ✅ Ready | `cd foodflow_dashboard && npm run build` |
| Admin build | ✅ Ready | `cd foodflow_admin && npm run build` |
| Landing page | ✅ Now has APK CTA | Deploy `foodflow_landing/` to Cloudflare Pages |
| Serve APK | ⚠️ Upload | Put `app-release.apk` at `/downloads/foodflow-latest.apk` on the landing host |

**What I need from you before you can push the button:**
- Registered domain (`foodflow.in` or similar)
- Cloudflare account (free tier)
- A cloud VM (Oracle Free or DO $6/mo)
- Firebase project (see §2)
- Razorpay Live keys (see §4)

---

## 2. Firebase integration + push notifications

**Server side:** ✅ complete. `pushService.js` speaks Firebase HTTP v1 with a service-account JSON. Needs two env vars:
```
FCM_PROJECT_ID=foodflow-prod
FCM_SERVICE_ACCOUNT_JSON=<base64 of the service-account JSON>
```

**Client side:** wiring is done, activation is one command away.
- `AuthProvider._postLogin()` fires after every sign-in and calls `NotificationService.instance.registerFcmToken(businessId)` (already in place after today's Day-1 work).
- `pubspec.yaml` has the two Firebase deps commented, ready to uncomment.
- `notification_service.dart` has the three lines to uncomment inside `registerFcmToken`.

**Steps to activate (~90 min):**
1. **console.firebase.google.com** → *Add project* → name it `foodflow-prod`.
2. *Add app* → Android → package `in.foodflow.app` (or whatever `android/app/build.gradle`'s `applicationId` is).
3. Download `google-services.json`, drop it in `foodflow_flutter/android/app/`.
4. In `foodflow_flutter/pubspec.yaml`, uncomment the two `firebase_*` lines.
5. In `foodflow_flutter/lib/services/notification_service.dart`, replace the placeholder block inside `registerFcmToken` with the three real lines (already documented in that file's comments).
6. In `foodflow_flutter/android/build.gradle`, add `classpath 'com.google.gms:google-services:4.4.0'` inside `buildscript.dependencies`.
7. In `foodflow_flutter/android/app/build.gradle`, add `apply plugin: 'com.google.gms.google-services'` at the bottom.
8. Firebase Console → Project settings → Service accounts → Generate new private key. Base64 the JSON, paste into `FCM_SERVICE_ACCOUNT_JSON` on the backend.
9. Rebuild the APK, sign in, verify Sentry / server logs show `[push]` sends succeeding.

**Cost:** Free for FoodFlow's scale (Firebase Blaze plan is only needed for outbound HTTP function calls, which we don't use).

---

## 3. OTP — cheap Indian options

**Ranked, best first:**

| Provider | Cost/OTP | DLT approval | Verdict |
|---|---:|---|---|
| **MSG91** | **₹0.13** | Required (~1-2 day approval, free) | **Recommended.** Cleanest OTP-specific API, dashboards, good docs. Ships today. |
| Fast2SMS | ₹0.10 | Yes | Cheaper by 3 paise but no first-class OTP flow, you build the retry/validate loop. |
| 2Factor.in | ₹0.10-0.20 | Yes | Fine, less polished than MSG91. |
| Firebase Phone Auth | **Free** up to 10k/month | Not needed (they own the SMS) | Free is tempting, but forces reCAPTCHA on Android and adds ~150 KB to the APK. Fine for a v2. |
| Twilio Verify | ~₹4 | Not needed | Global, expensive, only if you go multi-country. |

**What I shipped today:**
- `services/otpService.js` — MSG91-first, with a `OTP_DEV_MODE=1` fallback that just logs the code to console so we can dev without SMS spend.
- Migration `053_otp_and_aggregator_link.sql` — `otp_requests` table with bcrypt-hashed codes, 10 min TTL, 5 attempts max, 3 sends/hour/phone rate limit.
- Unit test `otpNormalize.test.js` — 8 assertions on phone number formatting (all green).

**What I need from you:**
- MSG91 account at https://control.msg91.com (free to sign up)
- DLT sender-ID application through your telecom provider (~₹1000 refundable deposit, ~2 days approval)
- Approved DLT OTP template — MSG91 walks you through this
- Once approved, drop these into your prod `.env`:
  ```
  MSG91_AUTHKEY=xxx
  MSG91_SENDER=FOODFL
  MSG91_OTP_TEMPLATE_ID=xxx
  ```

---

## 4. Razorpay live activation

Backend already speaks Razorpay for subscriptions + refunds. Test-mode works today. To flip live:

1. **KYC** (2-3 business days)
   - PAN (business or founder)
   - Cancelled cheque of the business current account
   - GSTIN (mandatory for platform fees)
   - Company / MSME / shop-and-establishment certificate
   - Your website URL — **they check the site is live**, so deploy the landing page FIRST

2. **Live keys**
   - Razorpay Dashboard → Settings → API Keys → Generate Live Keys
   - Replace the three env vars:
     ```
     RAZORPAY_KEY_ID=rzp_live_xxx
     RAZORPAY_KEY_SECRET=xxx
     RAZORPAY_WEBHOOK_SECRET=xxx
     ```

3. **Live plans**
   - The subscription plans defined in `db/seeds/plans_seed.sql` reference **test-mode** `plan_id`s. Recreate the same plans in Razorpay live dashboard, then update those IDs in the DB.
   - Command: `psql -f db/seeds/plans_seed.sql` after editing the file with live plan IDs.

4. **Webhook endpoint**
   - Add `https://api.foodflow.in/v1/webhooks/razorpay` in Razorpay dashboard.
   - Enable events: `payment.captured`, `payment.failed`, `subscription.activated`, `subscription.charged`, `subscription.halted`, `refund.processed`.

5. **Test the live flow with ₹1**
   - Create a temporary plan at ₹1/month in the live dashboard.
   - Subscribe as yourself with a real card.
   - Verify `subscription.activated` webhook lands, subscription row shows `status='active'`.
   - Cancel + refund. Confirm `refundReconcileService.tick()` picks up the pending row and flips to `processed`.

**What I need from you:**
- KYC docs above
- Razorpay merchant approval email (they'll send when live keys are activated)
- Live plan IDs to update in `plans_seed.sql`

---

## 5. APK distribution + landing page

**Shipped today:**
- Prominent APK download block in `foodflow_landing/index.html` after the hero. Shows:
  - "Android beta" badge with "Play Store in 2 days" line
  - **Download APK v1.0.0-beta** button (points to `/downloads/foodflow-latest.apk`)
  - **Share on WhatsApp** button (uses native share sheet on mobile, clipboard fallback on desktop)
  - Collapsible "How to install (30 seconds)" — walks a non-tech restaurant owner through Android's install-from-unknown-sources prompt.

**What you need to do:**
1. `cd foodflow_flutter && flutter build apk --release --split-per-abi`
2. Take the `app-arm64-v8a-release.apk` (works on 95% of Android phones), rename to `foodflow-latest.apk`.
3. Deploy `foodflow_landing/` to Cloudflare Pages (free, gets you SSL + CDN).
4. Upload the APK to `foodflow_landing/downloads/foodflow-latest.apk` OR host on Cloudflare R2 and change the button href.
5. Change the version string in the button label whenever you publish a new build.

**For sharing directly on WhatsApp** (no landing site needed): just send the R2 signed URL to a customer. The button on the landing page uses `navigator.share` which opens the Android/iOS native share sheet and lets the customer pick WhatsApp.

---

## 6. Zomato / Swiggy linking — honest take

The UX you described ("owner enters merchant phone → gets OTP → linked") requires the aggregator to send us that OTP. **Neither Zomato nor Swiggy publishes a documented "verify by phone + OTP" API.** Two paths, only one is safe:

### Path A — Official Partner API (recommended, 2-6 weeks)
- Apply as a Zomato POS partner: https://www.zomato.com/business/api
- Apply as a Swiggy POS partner: https://partner.swiggy.com/partners/register
- They review + sign an agreement + hand you credentials.
- Once approved, owners paste a **merchant_id + shared secret** in the Aggregators page (this is the existing flow — already built in `AggregatorsPage.tsx`).

### Path B — Reverse-engineered consumer OTP flow (do NOT ship)
- Yes, technically possible — grey-market POS clones do it.
- Violates ToS, breaks every ~90 days, gets your customers' Zomato accounts locked, and blocks your own Play Store listing when Google reviews the app.
- I did **not** implement Path B.

### What I shipped instead — a bridge that gets you the UX today
- `services/aggregatorLinkService.js` — new state machine `awaiting_otp → verified → linked`.
- `services/otpService.js` — sends the OTP **from FoodFlow** (via MSG91), so the owner sees a code and enters it. This proves they own that phone.
- Migration `053_otp_and_aggregator_link.sql` — new `aggregator_link_sessions` table.
- Three new endpoints in `sprintsAll.routes.js`:
  - `POST /aggregators/link/start` (body: `{provider, phone}`) — sends OTP, opens session
  - `POST /aggregators/link/verify` (body: `{sessionId, code}`) — marks session `verified`
  - `GET /aggregators/link/sessions` — dashboard visibility

**The verified session doesn't yet auto-fill outlet_id** — because that has to come from either Partner API or the owner. In practice, after OTP verification I recommend showing:

> ✅ Phone verified.  
> Now paste your **Zomato Restaurant ID** — you can find it in the Zomato Restaurant Partner app under _Menu → Settings → Restaurant ID_.

That preserves the "OTP-linked" UX for the owner (they feel it's magically linked to their Zomato account) while staying entirely within ToS. Once Partner API access lands, swap the manual outlet_id paste for an automatic Partner lookup — no other code changes.

**What I need from you:**
- Decide: apply for Partner APIs now (2-6 wk lag) OR ship with the OTP+manual-outlet-id flow for beta and upgrade later.
- If shipping now: I can build the dashboard UI for the two new endpoints in ~1 hour.

---

## The env vars you need before deploy

The full annotated template is `foodflow_backend/.env.production.example` —
copy that to `.env` and fill it. The critical keys:

```
NODE_ENV=production
PORT=4000
API_PREFIX=/v1
CORS_ORIGINS=https://foodflow.in,https://app.foodflow.in,https://admin.foodflow.in
DATABASE_URL=postgresql://foodflow:<pw>@<host>:5432/foodflow
JWT_SECRET=<64 random chars — boot FAILS in production if unset>
GOOGLE_CLIENT_IDS=<Google OAuth client id from console.cloud.google.com>
RAZORPAY_KEY_ID=rzp_live_<get from Razorpay>
RAZORPAY_KEY_SECRET=<from Razorpay>
RAZORPAY_WEBHOOK_SECRET=<from Razorpay>
MSG91_AUTHKEY=<from MSG91 — blank = OTP logged server-side only>
MSG91_SENDER=<DLT-registered sender id>
MSG91_OTP_TEMPLATE_ID=<from MSG91>
FCM_PROJECT_ID=<from Firebase — blank = push disabled>
FCM_SERVICE_ACCOUNT_JSON=<base64 SA JSON>
SENTRY_DSN=<from Sentry>
SUPER_ADMIN_EMAIL=you@foodflow.in
SUPER_ADMIN_PASSWORD=<strong initial pw, change on first login>
# Onboarding/transactional email (blank = emails suppressed, logged only)
SMTP_HOST=  SMTP_PORT=587  SMTP_USER=  SMTP_PASS=  SMTP_FROM=
APP_URL=https://app.foodflow.in
```

## Delivery checklist (minimum viable ship)

Absolute minimum to hand an APK to your first customer:

- [ ] Domain registered + Cloudflare + SSL
- [ ] Backend on Oracle/DO with the env vars set (`.env.production.example`)
- [ ] Migrations 001-054 applied
- [ ] Google OAuth client ID configured (mobile SHA-1 whitelisted)
- [ ] Firebase project + `google-services.json` in the APK
- [ ] MSG91 authkey (only if you want OTP flows live — otherwise `OTP_DEV_MODE=1`)
- [ ] Razorpay live keys (only if you want billing to work — trial customers don't need this)
- [ ] Landing page deployed with the APK link
- [ ] Signed release APK uploaded to `/downloads/foodflow-latest.apk`
- [ ] Sentry DSN added (crash reports)
- [ ] Test: sign in on a real phone with the APK, take one order, see it on the dashboard

Total wall-clock: ~1 day if you have your KYC docs ready.

— V.
