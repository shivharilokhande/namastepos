# FoodFlow — Execution Backlog

**Compiled by:** Ananya Desai (BA) + Rajan Iyer (PM) + Kavitha Nair (SM)
**Sign-off:** Arjun Mehta (Founder/CEO), Vikram Rao (CTO), Priya Sharma (CFO), Deepa Krishnan (CPO)
**Compiled on:** 2026-06-15
**Status:** Ready to execute — Sprint 11 starts today

This is the single source of truth for every remaining piece of work between "MVP feature-complete on dev" and "public GA on Play Store + App Store." Everything from the older `LAUNCH_PLAN.md`, `ROADMAP_POST_LAUNCH.md`, live task list (#111-#127), Product Backlog (61 stories) and the PetPooja parity research is consolidated here, deduplicated, prioritised, sized and assigned.

---

## 1. Team roster

| Role | Person | Files owned |
|---|---|---|
| Founder / CEO | Arjun Mehta | approves scope + release; final say on abort |
| CTO | Vikram Rao | tech decisions, security posture, build-vs-buy |
| CFO | Priya Sharma | effort/budget, abort thresholds |
| CPO | Deepa Krishnan | MVP scope, user journey, acceptance criteria |
| Director Product | Rajan Iyer | sprint plan, DoD, risk register |
| Director Engineering | Karthik V | DORA metrics, engineer assignment, sprint report |
| Director Design | Meera Joshi | wireframes, tokens, a11y |
| Scrum Master | Kavitha Nair | daily standup, unblock, velocity |
| Business Analyst | Ananya Desai | user stories, edge cases, API contracts |
| Architect | Srinivas Iyengar | system design, DB schema, ADRs |
| Backend Senior | Arun Patel | performance-critical + platform |
| Backend | Nikhil Gupta | auth, integrations, platform services |
| Frontend | Rhea Menon | React/Vite + Flutter |
| QA | Divya Srinivasan | test architecture + quality gate |
| DevOps | Rohan Chakraborty | infra, CI/CD, observability |

## 2. Priority framework

| Prio | Meaning | Ship-by |
|---|---|---|
| **P0** | Launch blocker — the product cannot go live without this | Sprint 11 |
| **P1** | First-customer safety — must land before any real customer touches the app | Sprint 12 |
| **P2** | Beta-window essentials — needed within 30 days of first customer | Sprint 13-14 |
| **P3** | Feature-parity + quality debt — needed within 90 days of first customer | Sprint 15-18 |
| **P4** | Deferred — only touch when a customer commercial ask forces it | when needed |

## 3. Definition of Done (DoD) — applies to every story

- Code merged to `main`, CI green
- ≥ 1 unit test + ≥ 1 integration test (or Playwright/E2E where UI is involved)
- Manual test pass by Divya (QA)
- Security review by Arun (backend/auth stories) or Vikram (crypto/data-boundary stories)
- Documented in `API_DOCS.md` or `USER_GUIDE.md`
- Deployed to `staging.foodflow.in` and smoke-tested
- Demo'd in sprint review; Rajan (PM) accepts

## 4. Definition of Ready (DoR) — a story enters a sprint only if

- User-story format (As a / I want / So that)
- ≥ 3 testable acceptance criteria
- Wireframe / mock linked (if UI)
- Dependencies identified
- Sized in story points (Fibonacci: 1, 2, 3, 5, 8, 13)
- Owner + reviewer named

---

## 5. Epics — the pending 12

Reading top-to-bottom is the order we tackle them in. Each epic is small enough to fit in 1-2 sprints; large epics are broken into phases (a/b/c).

| # | Epic | Prio | Pts | Sprint |
|---|---|---|---|---|
| E1 | Production Infrastructure | P0 | 21 | S11 |
| E2 | Security Hardening | P0 | 18 | S11 |
| E3 | Onboarding Polish | P1 | 24 | S11-S12 |
| E4 | Compliance Finalisation | P1 | 15 | S12 |
| E5 | Corporate Setup | P2 | 8 | S12 |
| E6 | Beta Operations | P2 | 13 | S12-S13 |
| E7 | PetPooja Parity — Dashboard | P3 | 21 | S13-S14 |
| E8 | PetPooja Parity — Multi-Outlet | P3 | 13 | S14 |
| E9 | PetPooja Parity — CRM Surface | P3 | 21 | S15 |
| E10 | Test Coverage Backfill | P3 | 40 | S15-S17 |
| E11 | App Store Publishing | P3 | 13 | S16 |
| E12 | Deferred | P4 | 55 | later |

**Sprint capacity:** 40 pts / sprint (solo dev + 1 QA + 1 designer, part-time). Below numbers assume Shivhari as lead engineer.

---

## 6. Backlog — user stories, epic by epic

Story IDs continue the FF- series from `planning/PRODUCT_BACKLOG.md`. Each story includes acceptance criteria and owner.

### EPIC E1 — Production Infrastructure (P0, 21 pts) → Sprint 11

Goal: turn `foodflow.in` from a URL we own on paper into a working stack in India.

**FF-201 · Buy foodflow.in domain (1 pt)** — Shiv
- AC: Domain registered at Cloudflare Registrar, DNS delegated to Cloudflare, WHOIS privacy on
- AC: Registration receipt filed
- AC: `dig foodflow.in` returns Cloudflare NS

**FF-202 · Provision India-region VM (3 pts)** — Rohan
- AC: Oracle Cloud Mumbai `VM.Standard.A1.Flex`, 4 OCPU / 24 GB / 200 GB
- AC: Ubuntu 22.04, SSH key installed
- AC: Security list allows :22 :80 :443 from world
- AC: Public IPv4 reserved, documented in `DEPLOYMENT.md`
- Fallback if Oracle capacity denied: DigitalOcean Bangalore $6 droplet

**FF-203 · DNS + TLS records (2 pts)** — Rohan
- AC: A records for `@`, `www`, `api`, `app`, `admin` → VM IP (grey cloud, DNS-only for `api`)
- AC: Let's Encrypt certs issued for all four via nginx + certbot
- AC: HTTPS forced (301 from :80)
- AC: `curl -I https://api.foodflow.in/v1/health` returns 200

**FF-204 · Backend stack install (3 pts)** — Rohan
- AC: Node 20, PostgreSQL 14, Redis 7, nginx, PM2, ufw, fail2ban all installed
- AC: PM2 saved + startup script wired
- AC: Postgres user `foodflow` created with strong random pw
- AC: nginx reverse proxies :443 → :4000 (api), :5173 (admin), :5174 (dashboard)
- AC: nginx configs in `deploy/nginx/*.conf` committed

**FF-205 · Prod .env with real secrets (2 pts)** — Shiv (must be human)
- AC: `JWT_SECRET` = `openssl rand -base64 48`
- AC: `CORS_ORIGINS` explicit list (no `*`)
- AC: Razorpay LIVE keys pasted
- AC: Google OAuth Web + iOS client IDs
- AC: Twilio prod creds, Sentry DSN placeholder
- AC: `.env` NOT committed, only `.env.example`

**FF-206 · Apply migrations + seed compliance (2 pts)** — Rohan
- AC: `npm run migrate` completes cleanly (all 41 migrations)
- AC: `psql -d foodflow < scripts/seed-compliance.sql` sets Grievance Officer
- AC: `GET /v1/compliance/grievance-officer` returns Shivhari's details

**FF-207 · Razorpay webhook wired to prod (2 pts)** — Nikhil
- AC: Razorpay dashboard webhook URL updated to `https://api.foodflow.in/v1/webhooks/razorpay`
- AC: Webhook secret in prod `.env`
- AC: Test event delivered + processed (200 in Razorpay logs)

**FF-208 · Daily pg_dump to Wasabi Mumbai (3 pts)** — Rohan
- AC: Cron at 03:00 IST runs `scripts/backup-db.sh`
- AC: Backups gzip'd, filename includes date
- AC: Wasabi Mumbai bucket `foodflow-backups` with 30-day lifecycle
- AC: Weekly restore-test to a scratch DB (documented, doesn't need to be automated in first sprint)

**FF-209 · Landing page deployed (2 pts)** — Rhea
- AC: `foodflow_landing/index.html` served on `www.foodflow.in` via Cloudflare Pages
- AC: `FOODFLOW_URLS` block updated to prod domains
- AC: Support emails `hello@foodflow.in` / `support@foodflow.in` alive (see E5)

**FF-210 · /health prod verification (1 pt)** — Divya
- AC: `curl` from external network (mobile tether) hits all four subdomains
- AC: `npm test -- compliance.test.js` passes against prod DB

---

### EPIC E2 — Security Hardening (P0, 18 pts) → Sprint 11

Goal: close the P1 security holes before we invite anyone.

**FF-211 · Sentry wiring — backend + dashboard + admin + mobile (5 pts)** — Rohan + Rhea
- AC: Sentry free-tier project created
- AC: Backend loads DSN from env, captures uncaught exceptions
- AC: Dashboard + admin (Vite) upload sourcemaps on build
- AC: Flutter Sentry SDK captures crashes on both iOS + Android
- AC: Trigger a test event in each surface, verify it lands in Sentry dashboard

**FF-212 · IDOR audit on /businesses/:id/* routes (5 pts)** — Arun
- AC: Automated script that impersonates business A and hits every `/businesses/:idB/*` endpoint
- AC: Every route returns 403 or 404 (never 200) for cross-tenant access
- AC: Failures logged to `security-audit.md` with severity
- AC: Any 200 leak fixed and Playwright test added

**FF-213 · Cookie flags audit (2 pts)** — Nikhil
- AC: `ff_refresh` cookie has `HttpOnly` + `Secure` + `SameSite=Lax` in prod
- AC: Any session cookies audited for the same
- AC: `Set-Cookie` header verified via `curl -I`

**FF-214 · JWT secret rotation policy (2 pts)** — Vikram + Arun
- AC: Runbook doc `SECRETS.md` — how to rotate `JWT_SECRET` without kicking every user out
- AC: Grace-period support in `verifyAccessToken` (accept last N secrets) OR planned rotation window
- AC: Prod `JWT_SECRET` documented in a password manager (1Password / Bitwarden)

**FF-215 · Sentry rate limits + PII scrubbing (2 pts)** — Rohan
- AC: Sentry `beforeSend` scrubs email, phone, JWT, business names from error payloads
- AC: Rate limit set to prevent runaway billing

**FF-216 · Dependency vulnerability scan (2 pts)** — Divya
- AC: `npm audit --production` clean or documented exceptions
- AC: `flutter pub outdated --security` reviewed
- AC: High/critical CVEs patched or noted with mitigation

---

### EPIC E3 — Onboarding Polish (P1, 24 pts) → Sprint 11-12

Goal: a stranger can complete signup → first POS sale without help.

**FF-217 · First-time setup wizard on mobile + dashboard (8 pts)** — Rhea + Meera
- AC: New user lands on wizard after registration: Business info → GSTIN (optional) → Menu bulk import → Add first table → done
- AC: Wizard state persists across app closes
- AC: "Skip for now" on each step, but nudged back into it from Home
- AC: Same wizard renders on mobile + dashboard (single source of truth)

**FF-218 · Menu CSV bulk-import UX (3 pts)** — Rhea
- AC: Template CSV downloadable
- AC: Column mapping UI if headers don't match
- AC: Preview 10 rows before commit
- AC: Errors shown per-row with retry
- Backend endpoint already exists (`bulkImport` route)

**FF-219 · Network-down graceful screen on mobile (3 pts)** — Rhea
- AC: When `/health` fails, mobile shows "You're offline. New orders will send when you reconnect." banner
- AC: New KOTs enqueue into existing SQLite outbox
- AC: On reconnect, outbox flushes automatically
- AC: No red DioException screens ever visible to end-user

**FF-220 · Plain-English error messages (4 pts)** — Rhea + Ananya
- AC: Central `humanizeError()` helper on mobile + dashboard
- AC: Every `catch (e)` displays humanized text, not raw exception
- AC: Common 4xx codes mapped: 401 → "Please sign in again", 402 → "This feature isn't in your plan", 404 → "Not found", 429 → "Slow down for a moment"
- AC: Sentry still gets the raw error server-side

**FF-221 · WhatsApp support button in-app (1 pt)** — Rhea
- AC: Settings → Help section has "Chat with support on WhatsApp" tile
- AC: Opens `https://wa.me/919518956711?text=Hi%20from%20FoodFlow` with pre-filled body
- AC: Same tile on dashboard Help widget

**FF-222 · Pricing page on landing site (2 pts)** — Rhea
- AC: `/pricing` route on landing (Cloudflare Pages sub-page)
- AC: Reads `/v1/plans` via public CORS
- AC: Feature matrix table for Starter / Pro / Enterprise
- AC: CTA → `/register`

**FF-223 · Onboarding email sequence (3 pts)** — Nikhil + Rajan
- AC: Day 0: welcome, first-setup video (Loom, 2 min)
- AC: Day 3: "here's how to send WhatsApp receipts"
- AC: Day 14: "trial ends in 16 days — book a call"
- AC: Delivered via Resend, unsub link included

---

### EPIC E4 — Compliance Finalisation (P1, 15 pts) → Sprint 12

Goal: DPDP-clean before first paid customer.

**FF-224 · Lawyer engagement + Privacy Policy signoff (5 pts)** — Arjun + external
- AC: Startup lawyer briefed on FoodFlow scope
- AC: Existing DRAFT scaffold in `LegalPage.tsx` + `privacy_policy_screen.dart` reviewed
- AC: Redlined version accepted
- AC: `PRIVACY_POLICY_VERSION` bumped in both apps
- AC: New version live at `foodflow.in/legal/privacy`
- Blocked by: nobody. Kick off in Sprint 11 in parallel with infra.

**FF-225 · Lawyer signoff — Terms of Service + Customer SaaS Agreement (3 pts)** — Arjun + external
- AC: Redlined ToS + SaaS agreement received
- AC: `TERMS_OF_SERVICE_VERSION` bumped
- AC: New version live at `foodflow.in/legal/terms`

**FF-226 · Grievance Officer contact published (1 pt)** — Nikhil
- AC: `PUT /v1/admin/compliance/settings` fed with real contact via super-admin UI
- AC: `GET /v1/compliance/grievance-officer` returns Shivhari's live contact
- AC: Contact rendered in mobile app + dashboard footer + landing

**FF-227 · Breach response runbook (3 pts)** — Vikram + Arun
- AC: `BREACH_RUNBOOK.md` — phone tree, DPB contact, CERT-In contact, customer email template
- AC: DPDP s.8(6) 72-hour notification path defined
- AC: Table-top exercise once, notes captured

**FF-228 · Data Protection Officer designation (2 pts)** — Arjun
- AC: DPO is either Shivhari (until 10k customers) or a designated person
- AC: DPO contact set via `dpoName` / `dpoEmail` in `compliance_settings`
- AC: DPO name in privacy policy

**FF-229 · Consent-audit sanity test (1 pt)** — Divya
- AC: Register a fresh account, tick 2 of 3 marketing consents
- AC: Verify 3 rows in `consent_events` (privacy_policy, terms_of_service, marketing_email)
- AC: Verify 0 rows for the un-ticked one
- AC: Withdraw one consent → 4th row with `granted=false`
- AC: Export account data → JSON contains full consent history

---

### EPIC E5 — Corporate Setup (P2, 8 pts) → Sprint 12

Goal: legal entity + GSTIN + bank account, so invoices show a real company.

**FF-230 · Pvt Ltd incorporation (5 pts)** — Arjun + CA
- AC: Company name cleared (see `NAME_CLEARANCE.md`)
- AC: MoA / AoA drafted and filed with MCA
- AC: Incorporation certificate + CIN received
- AC: PAN + TAN issued
- Expected turnaround: 2-3 weeks

**FF-231 · GSTIN registration (2 pts)** — CA
- AC: GST registration filed
- AC: GSTIN issued
- AC: GSTIN plugged into `compliance_settings.legal_entity_gstin`
- AC: Invoice PDFs render new GSTIN

**FF-232 · Current account + Razorpay payouts switched (1 pt)** — Shiv
- AC: Current account opened at RBL / ICICI / HDFC
- AC: Razorpay dashboard payout bank changed from personal to current account
- AC: First payout to current account verified

---

### EPIC E6 — Beta Operations (P2, 13 pts) → Sprint 12-13

Goal: infrastructure for running a controlled beta.

**FF-233 · Staging environment (3 pts)** — Rohan
- AC: Second Docker compose stack targeting `foodflow_staging` DB
- AC: `staging.foodflow.in` subdomain (yellow cloud in Cloudflare — proxy on, cheaper)
- AC: `staging` runs from `staging` git branch
- AC: `main` → dev VM; `production` → prod VM
- AC: Doc `STAGING.md` explains the promotion flow

**FF-234 · Disaster-recovery runbook (2 pts)** — Rohan
- AC: One-page `DR_RUNBOOK.md` with copy-paste commands: restore latest backup, roll forward N migrations, restart PM2, verify /health
- AC: Table-top DR exercise once (kill prod VM, restore in <60 min)

**FF-235 · UptimeRobot status page (1 pt)** — Rohan
- AC: Free UptimeRobot account monitors `/health` every 5 min
- AC: Public status page at `status.foodflow.in`
- AC: Alerts to Shiv's WhatsApp on downtime > 5 min

**FF-236 · Support inbox (2 pts)** — Shiv
- AC: `support@foodflow.in` provisioned (Zoho Mail free tier)
- AC: Auto-responder set with SLA ("we reply within 24h on weekdays")
- AC: Address linked from mobile app + dashboard + landing footer

**FF-237 · Outbound email via Resend (3 pts)** — Nikhil
- AC: Resend account + domain verified (SPF, DKIM, DMARC)
- AC: `MAIL_FROM=support@foodflow.in`
- AC: Backend can send: password reset, invoice receipt, DSR completion
- AC: Send test to Shivhari's personal Gmail, verify delivery + rendering

**FF-238 · Beta customer scorecard sheet (2 pts)** — Rajan
- AC: Google Sheet template — one row per beta customer
- AC: Columns: name, business, phone, join date, daily-active-day count, top-3 feature asks, verbatim quotes, verbal-pay-commit
- AC: 5 beta candidates identified from network (own café, friends of family, etc.)

---

### EPIC E7 — PetPooja Parity: Dashboard (P3, 21 pts) → Sprint 13-14

Goal: `/` (Overview page) matches PetPooja's information density.

**FF-239 · Payment-method breakdown on Total Sales card (3 pts)** — Rhea + Nikhil
- AC: Backend returns `paymentBreakdown` in dashboard summary endpoint: `{ cash, card, upi, online, other, notPaid }` in ₹
- AC: Dashboard renders 6 sub-lines on the Total Sales card

**FF-240 · Order-status split + bar chart (2 pts)** — Rhea
- AC: Total Orders card shows: Successful, Complementary (freebies), Cancelled counts
- AC: Tiny 3-bar recharts widget alongside

**FF-241 · Channel tiles (Dine-in / Pickup / Delivery) with TTA (3 pts)** — Rhea + Nikhil
- AC: Three cards under Total Sales, one per channel
- AC: Each shows: revenue, order count, average turn-around-time (KOT → collected)
- AC: TTA computed backend-side: `AVG(collected_at - created_at)` for today's orders in that channel

**FF-242 · Sync-freshness badges (2 pts)** — Rhea + Nikhil
- AC: Top of dashboard shows "POS synced N min ago" + "Orders synced N min ago"
- AC: Backend heartbeat writes to `sync_status` table on every mobile/dashboard order fetch
- AC: Turns amber after 15 min, red after 60 min

**FF-243 · Action Center pill (5 pts)** — Nikhil + Rhea
- AC: Top-right pill shows count of items needing attention
- AC: Popover lists: KOTs > 30 min old and still pending, bills unpaid > 24h, addons expiring in 7d, low-stock items (if ingredients addon active), staff members over plan cap
- AC: Each item deep-links to its detail

**FF-244 · Leakage report card (3 pts)** — Nikhil + Rhea
- AC: New card showing today's KOT Cancelled / Modified / Not-used-in-bills / Shifted counts
- AC: Bills Modified / Re-printed / Waived-off counts
- AC: Data sourced from existing `audit_log` on order+bill mutations

**FF-245 · Expenses + Withdrawals card (2 pts)** — Rhea
- AC: Card on dashboard showing today's Expenses / Withdrawals / Cash Top-up totals
- AC: "View Breakdown" link → expense register

**FF-246 · Data Management banner (1 pt)** — Rhea
- AC: Top-of-dashboard banner that links to `/privacy` for retention preferences
- AC: Dismissible per user; re-shows monthly

---

### EPIC E8 — PetPooja Parity: Multi-Outlet (P3, 13 pts) → Sprint 14

Goal: one owner can manage multiple restaurants.

**FF-247 · User can belong to multiple businesses (3 pts)** — Nikhil
- AC: `business_users` already supports many-to-many. Add UI: on login/register, if user has > 1 membership, prompt "Which restaurant?" or default to last-active
- AC: Backend `/auth/switch-business` endpoint already exists

**FF-248 · Top-bar outlet switcher (3 pts)** — Rhea
- AC: Dashboard sidebar top has a dropdown listing all outlets the user belongs to
- AC: Selecting switches backend context (`/auth/switch-business`) + refreshes all queries
- AC: Mobile "More" tab has the same switcher

**FF-249 · Create additional outlets (2 pts)** — Rhea + Nikhil
- AC: Super-admin can create an additional outlet under the same owner user
- AC: Owner sees the new outlet appear in the switcher after next fetch

**FF-250 · Multi-outlet rollup reports (5 pts)** — Arun + Rhea
- AC: Reports gains an "All outlets" toggle
- AC: P&L / Revenue / Orders roll up across selected outlets
- AC: Charts show per-outlet stacked bars

---

### EPIC E9 — PetPooja Parity: CRM Surface (P3, 21 pts) → Sprint 15

Goal: turn Customers module from a raw list into a marketing surface.

**FF-251 · Customer segments builder (5 pts)** — Nikhil + Rhea
- AC: New page: build a filter on customer attributes (spend, visit count, days-since-last-visit, birthday-in-N-days)
- AC: Preview count updates live
- AC: Save as named segment, editable

**FF-252 · Campaign composer (5 pts)** — Nikhil + Rhea
- AC: Pick segment → pick channel (email / WhatsApp / SMS) → pick template → schedule/send
- AC: Preview renders on both channels
- AC: Backend integrates with Twilio (WhatsApp/SMS) + Resend (email)

**FF-253 · Gift cards (5 pts)** — Arun + Rhea
- AC: New `gift_cards` table (id, code, denomination_paise, issued_at, redeemed_at, business_id)
- AC: Owner can create gift cards (auto-gen 12-char code)
- AC: POS checkout has "Apply gift card" flow → deducts from bill total
- AC: Redemption is idempotent (one card = one use)

**FF-254 · Feedback / reviews (3 pts)** — Nikhil + Rhea
- AC: Restore the reviews module (removed in Push 17a)
- AC: Post-collection auto-WhatsApp includes a 5-star rating link
- AC: Inbox view on dashboard shows all reviews with reply option

**FF-255 · Petpooja-style loyalty tiers (3 pts)** — Nikhil
- AC: Existing loyalty already has `bronze / silver / gold` tiers — surface them in dashboard
- AC: Owner can set point-thresholds per tier + tier-specific discount %

---

### EPIC E10 — Test Coverage Backfill (P3, 40 pts) → Sprint 15-17

Goal: raise the confidence bar so we can ship faster without breaking things.

**FF-256 · Phase 1: Backend security audit + fixes (5 pts)** — Arun
- Existing pending task #111 (currently in-progress)
- AC: All findings from FF-212 (IDOR sweep) closed
- AC: `security-audit.md` updated

**FF-257 · Phase 2: Backend integration tests (8 pts)** — Divya
- Existing pending task #112
- AC: Jest + Supertest cover every controller happy path
- AC: 60%+ line coverage on `src/controllers` + `src/services`
- AC: CI runs against ephemeral test DB

**FF-258 · Phase 3: Admin Playwright gap-fill (5 pts)** — Divya
- Existing pending task #113
- AC: Every admin page has a Playwright spec exercising happy path
- AC: Runs in CI on every push

**FF-259 · Phase 4: Dashboard Playwright gap-fill (8 pts)** — Divya
- Existing pending task #114
- AC: ~35 flows covered (order lifecycle, staff, reports, settings, privacy)
- AC: Runs in CI

**FF-260 · Phase 5: Flutter widget + integration tests (8 pts)** — Divya + Rhea
- Existing pending task #115
- AC: `flutter test` covers login, order placement, KOT flow, settle, session release
- AC: Golden tests for key screens

**FF-261 · Phase 6: Code quality pass (5 pts)** — Karthik
- Existing pending task #116
- AC: `eslint --max-warnings 0` on all JS
- AC: `flutter analyze` warnings ≤ 5
- AC: DB indexes added for slow queries (identified via `pg_stat_statements`)

**FF-262 · Sentry alert routing (1 pt)** — Rohan
- AC: Sentry alerts route to Shiv's WhatsApp for P0 issues, email for P1+, silent for info

---

### EPIC E11 — App Store Publishing (P3, 13 pts) → Sprint 16

Goal: shippable Android AAB + iOS IPA.

**FF-263 · Release keystore + signing (2 pts)** — Rohan
- AC: `keytool -genkey` release keystore, backed up to 1Password + local encrypted drive
- AC: `android/app/build.gradle` release config points to it
- AC: Signing password NOT in git

**FF-264 · Launcher icons + splash (2 pts)** — Meera + Rhea
- AC: `flutter_launcher_icons` set up with a 1024×1024 source
- AC: All `mipmap-*` PNGs generated for Android
- AC: iOS `AppIcon.appiconset` populated
- AC: Placeholder vector removed

**FF-265 · Google OAuth Android release client (1 pt)** — Nikhil
- AC: Google Cloud Console: new OAuth Android client with `in.foodflow.app` + release keystore SHA-1
- AC: Test sign-in via a debug build with release keystore fingerprint

**FF-266 · Play Store listing (3 pts)** — Meera + Rajan
- AC: Screenshots (6), feature graphic (1024×500), icon (512×512)
- AC: Short description ≤80 chars
- AC: Full description
- AC: Privacy Policy URL = `https://foodflow.in/legal/privacy`
- AC: Data safety form completed (declares consent capture, DPDP compliance, no third-party sharing except processors)
- AC: `flutter build appbundle --release --dart-define=API_URL=https://api.foodflow.in/v1 ...`
- AC: Uploaded to Internal Testing track, tested by ≥ 3 people

**FF-267 · iOS App Store submission (3 pts)** — Rohan + Meera
- AC: Apple Developer account ($99/year)
- AC: `flutter build ios --release`
- AC: TestFlight upload, tested by ≥ 3 people
- AC: App Review notes explicitly mention MFi printer limitation
- AC: In-app-purchase declaration: none (payments via Razorpay web checkout)

**FF-268 · Play Store production track after 2 weeks internal (2 pts)** — Rajan
- AC: 2 weeks of internal-track feedback logged, P0 bugs fixed
- AC: Promoted to Open Testing → Production
- AC: Rollout at 10% first, then 50%, then 100%

---

### EPIC E12 — Deferred (P4, 55 pts) → later

Only touch when a customer commercial ask forces it.

**FF-269 · Captain table-tap bug fix (2 pts)** — Rhea
- Existing pending task #127

**FF-270 · E-invoice IRN integration (13 pts)** — Arun
- Trigger: first customer with turnover > ₹5 Cr
- AC: NIC IRP integration, IRN generation, QR on invoice

**FF-271 · Voice POS (5 pts)** — Rhea
- Re-enable `speech_to_text` once dep conflict resolved

**FF-272 · Direct Zomato/Swiggy APIs (13 pts)** — Nikhil
- Replace webhook stubs with real partner APIs after signing partner agreements

**FF-273 · Print-agent installer + auto-update (5 pts)** — Rohan
- One-click installer for Windows / macOS / Linux

**FF-274 · Native iOS BLE printer (BLE, not classic BT) (8 pts)** — Rhea
- For iOS customers with BLE-capable thermal printers (bypasses MFi gate)

**FF-275 · Multi-currency / multi-region (13 pts)** — Arun
- Trigger: expansion outside India

**FF-276 · Menu schedule (item availability by time-of-day) (3 pts)** — Rhea

**FF-277 · Device mapping (label printers/terminals) (3 pts)** — Rhea

**FF-278 · Item commission (per-item % for waiter incentives) (3 pts)** — Arun

**FF-279 · Audit trail UI (super-admin) (2 pts)** — Rhea

---

## 7. Sprint schedule (Sprint 11 onwards)

Assumptions: 2-week sprints, 40 pts / sprint (mostly solo Shivhari, plus lawyer + CA + designer running in parallel).

| Sprint | Dates (2026) | Committed pts | Stories |
|---|---|---|---|
| **S11** | Jun 15 → Jun 28 | 39 | FF-201..210 (E1, 21 pts) + FF-211..216 (E2, 18 pts) |
| **S12** | Jun 29 → Jul 12 | 40 | FF-217..223 (E3, 24 pts) + FF-224..229 (E4, 15 pts) — lawyer runs in parallel |
| **S13** | Jul 13 → Jul 26 | 39 | FF-230..232 (E5, 8 pts, mostly CA) + FF-233..238 (E6, 13 pts) + FF-239..244 (E7 first half, 15 pts) |
| **S14** | Jul 27 → Aug 9 | 39 | FF-245..246 (E7 tail, 6 pts) + FF-247..250 (E8, 13 pts) + FF-256 (Phase 1 tests, 5 pts) + FF-262 (1 pt) + BUFFER (14 pts) for beta feedback fixes |
| **S15** | Aug 10 → Aug 23 | 40 | FF-251..255 (E9, 21 pts) + FF-257 (Phase 2 tests, 8 pts) + FF-258 (Phase 3 tests, 5 pts) + FF-269 (2 pts) + buffer 4 pts |
| **S16** | Aug 24 → Sep 6 | 39 | FF-259 (Phase 4 tests, 8 pts) + FF-263..268 (E11 Play Store, 13 pts) + FF-260 (Phase 5 tests, 8 pts) + buffer 10 pts |
| **S17** | Sep 7 → Sep 20 | 30 | FF-261 (Phase 6 code quality, 5 pts) + P4 items on demand |

**Beta window:** starts end of S12 (~Jul 12). 3-5 hand-picked customers, free 90 days.
**Play Store production:** aiming for early September (end of S16).
**GA public:** late September / early October.

---

## 8. Risk register

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| Lawyer turnaround > 2 weeks | S12 slips | M | Kick off in S11, not S12; accept "DRAFT" watermark in first beta if late |
| Oracle Cloud denies capacity | S11 slips 1 day | L | Fallback to DigitalOcean Bangalore ready |
| Razorpay LIVE approval delayed | Payments broken | L | Already have active account, just switch keys |
| CA takes > 3 weeks on incorporation | Personal-name invoices in beta | H | Accept; disclose to first 5 beta customers |
| Google OAuth Android approval | Sign-in broken on Play | L | Already approved for web; adding Android client is instant |
| MFi restriction blocks iOS printer | iOS customers can't print | M | Document in App Review; recommend Android for cafés |
| Beta customer churns in week 1 | Signal wrong PMF | M | Rajan's onboarding calls catch friction early; iterate |

---

## 9. Metrics we track

- **DORA**: deployment frequency (target: daily to staging, weekly to prod), lead time (target: <24h from PR to prod), MTTR (target: <2h)
- **Product**: DAU per customer, sessions per day, orders per day, average order value
- **Business**: signups per week, trial → Pro conversion %, MRR, churn
- **Support**: WhatsApp response time (target: <2h in-hours), ticket resolution time

Dashboards live in Sentry (errors) + super-admin (business metrics) + UptimeRobot (availability).

---

## 10. Sprint 11 kickoff — starting now

**Committed this sprint:** 39 pts
**Sprint goal:** Deploy production stack + close P1 security gaps.

**Day 1-3 (parallel):**
- Rohan spins up Oracle Cloud VM (FF-202, 3 pts)
- Shiv buys domain (FF-201, 1 pt)
- Arjun briefs lawyer (starts FF-224, will complete in S12)

**Day 4-6:**
- Rohan: DNS + TLS + backend stack install (FF-203, FF-204, 5 pts)
- Nikhil: Razorpay webhook + JWT rotation (FF-207, FF-214, 4 pts)

**Day 7-9:**
- Rohan: pg_dump cron + Sentry backend (FF-208, FF-211 backend half, 5 pts)
- Arun: IDOR audit (FF-212, 5 pts)
- Rhea: Sentry dashboard + Sentry Flutter (FF-211 UI halves, 2 pts)

**Day 10-12:**
- Shiv: prod .env + apply migrations + seed compliance (FF-205, FF-206, 4 pts)
- Nikhil: cookie flags audit (FF-213, 2 pts)
- Rhea: landing page deploy (FF-209, 2 pts)
- Divya: verify /health + dependency scan (FF-210, FF-216, 3 pts)

**Day 13 (sprint review + retro):**
- Demo prod stack live end-to-end
- Divya smoke tests: register → menu → order → settle from external network

**Definition of Sprint 11 done:**
- `https://app.foodflow.in`, `admin.foodflow.in`, `api.foodflow.in`, `www.foodflow.in` all live with TLS
- Sentry captures a test event from each of the 4 surfaces
- IDOR audit report shows 0 cross-tenant leaks
- pg_dump ran overnight, restored to scratch DB successfully
- Grievance officer contact live at `/v1/compliance/grievance-officer`
- Shivhari can register a fresh account from an external network in <5 minutes

**Standup cadence:** 10 min every weekday at 09:30 IST. Kavitha runs.

**Sprint review:** Sat morning end of week 2. Rajan hosts, Arjun signs off scope.

---

## Sign-off

Ready to execute. Sprint 11 opens today.

— Ananya (BA) · Rajan (PM) · Kavitha (SM) · Approved by Arjun (Founder)
