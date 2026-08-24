# FoodFlow — Deployment Guide

**Audience:** Solo founder. Practical, lowest-cost path to a live product.
**Target environment:** India-facing SaaS, beta-scale (5 customers → 100 customers).
**Total monthly cost at beta scale:** ~₹65–500 ($1–6) using the free-first stack.

> 🛑 **READ FIRST:** This deployment plan is **gated by compliance work** described in [COMPLIANCE.md](COMPLIANCE.md). Phase 0 below must be complete before Phase A is started. Trying to deploy first and "do compliance later" is how SaaS startups end up with ₹250-crore DPDP penalty exposure.

---

## TL;DR — what hosts where (India-region, free-first)

| Component | Host | Why | Monthly cost (beta) |
|---|---|---|---:|
| Domain (`foodflow.in`) | Hostinger / GoDaddy / BigRock | `.in` is ~₹800/year | ₹70 |
| DNS + CDN | Cloudflare (free tier) | Free, fast, easy SSL | ₹0 |
| **Backend (Node.js)** | **Oracle Cloud Mumbai** (Always Free) — *or* DigitalOcean Bangalore ($4-6/mo) | **Data stays in India** (DPDP + RBI). Oracle = free forever, ARM 4-core 24GB. DO = easier but paid. | **₹0** or ₹350-500 |
| **Managed Postgres** | Oracle Autonomous DB (Mumbai, free 20GB) — *or* Neon Free (500MB, Singapore — declare in privacy policy) | India-region preferred for DPDP. Self-hosted Postgres on the Oracle VM is also fine. | **₹0** |
| Dashboard (React) | Cloudflare Pages | Free, instant deploys from Git | ₹0 |
| Admin (React) | Cloudflare Pages | Same | ₹0 |
| File uploads | Cloudflare R2 | Pennies/GB, no egress fees | ₹0–50 (10GB free) |
| Email transactional | Resend free tier | 3k emails/mo free | ₹0 |
| SMS / WhatsApp | Twilio | Pay-per-message | ₹300–800 |
| Crash reporting | Sentry free tier | 5k events/mo free | ₹0 |
| Backups offsite | Cloudflare R2 | ₹0.0006/GB-month | ₹0–20 |
| Cookie consent | Klaro (self-hosted) or CookieYes free | DPDP requires consent UI | ₹0 |
| Payment processor | Razorpay | Per-txn fee, no monthly | ₹0 |
| iOS App Store | Apple Developer | $99/year | ₹680 |
| Android Play Store | Google Play Console | $25 one-time | ₹170 |
| **Total (Oracle path)** | | | **~₹65/mo + Apple/Google fees** |
| **Total (DigitalOcean path)** | | | **~₹500/mo + Apple/Google fees** |

If budget is the absolute bottleneck and you have a free weekend: **Oracle Cloud Mumbai Always Free** is genuinely the cheapest India-compliant option. The only ongoing cost at Phase 1 beta becomes the domain (~₹70/mo) and Twilio per-message charges.

If time is the bottleneck and you want one-click deploys: **DigitalOcean Bangalore** at ~₹500/mo is the easy path.

> ❌ **What changed from the original plan:** Render Singapore is removed because it puts Indian customer data outside India, which conflicts with DPDP cross-border transfer rules + RBI 2018 directive. Render does not currently offer an India region.

---

## Phase 0 — Compliance gate (BLOCKS everything below) 🛑

Before you provision a single server, these items from [COMPLIANCE.md](COMPLIANCE.md) must be in place. Estimated ~2 weeks of solo work + 1-2 weeks of lawyer turnaround in parallel.

### 0.1 Legal & corporate (~1 week, mostly waiting)
- [ ] **Incorporation chosen + filed** (Pvt Ltd / LLP / Sole Prop) — Task #124
- [ ] **GSTIN applied for** FoodFlow entity (you can launch beta on a sole-prop GSTIN if Pvt Ltd is still pending)
- [ ] **Current account opened** at any business bank (HDFC, ICICI, Kotak) — required for Razorpay settlement
- [ ] **Razorpay KYC** submitted (PAN, GSTIN, bank statement) — 2-3 days for approval
- [ ] **Lawyer briefed** on drafting Privacy Policy + ToS + DPA — Task #117, #118 (₹15-25k)

### 0.2 Privacy + consent (~3 days, gated by lawyer draft)
- [ ] **Privacy policy** drafted + reviewed by lawyer — Task #117
- [ ] **Terms of Service + SaaS Subscription Agreement** drafted — Task #118
- [ ] **Grievance Officer named** (you) + `grievance@foodflow.in` mailbox created — Task #120
- [ ] **Consent UI** in mobile signup + dashboard signup + QR guest order flow — Task #119
- [ ] **Consent audit log** table created + writes wired up — Task #122

### 0.3 Data subject rights (~2 days)
- [ ] **`GET /v1/me/export`** — data download — Task #121
- [ ] **`DELETE /v1/me/account`** — soft-delete with 30-day cooldown — Task #121
- [ ] **`PATCH /v1/me/correct`** — correction endpoint — Task #121
- [ ] Mobile Profile screen + dashboard Settings UI for the above

### 0.4 Hosting decision (~half day)
- [ ] **India-region host provisioned** — Task #123
  - Oracle Cloud Mumbai (Always Free) — ~4h setup, $0 forever
  - OR DigitalOcean Bangalore — ~1h setup, $4-6/mo
- [ ] If for any reason hosting stays outside India, **disclose the country in the privacy policy** under "Cross-border transfers"

### 0.5 Breach readiness (~1 day)
- [ ] **Breach response runbook** drafted — Task #126
- [ ] **Sentry** wired into all 4 surfaces (detection)
- [ ] **DPB notification email template** prepared
- [ ] **Customer notification template** prepared

### 0.6 Verify gate ✅
- [ ] Open `foodflow.in/privacy`, `foodflow.in/terms`, `foodflow.in/grievance` in a browser — all return real content
- [ ] Sign up via the mobile app — consent checkbox is present, can't proceed without it
- [ ] As yourself, hit `DELETE /v1/me/account` — account goes into 30-day cooldown
- [ ] As yourself, hit `GET /v1/me/export` — returns JSON download with your data
- [ ] Confirm with lawyer: ✉️ "Are we ready to take Customer #1?"

**Only after every checkbox above is green do you proceed to Phase A.**

---

## Phase A — Pre-flight (do this first, no code changes)

### A.1. Buy the domain (~30 min)

- Go to **Hostinger India** or **BigRock** (Indian-issued `.in` is cheaper there than GoDaddy)
- Search `foodflow.in` — if taken, try `getfoodflow.in`, `foodflow.app`, `myfoodflow.in`
- Buy for 1 year (~₹800)
- Skip every up-sell (privacy, hosting, email — Cloudflare gives you these free)

### A.2. Move DNS to Cloudflare (~20 min)

- Create a free **Cloudflare** account
- Add `foodflow.in` as a site
- Cloudflare gives you 2 nameservers (looks like `dora.ns.cloudflare.com`, `mark.ns.cloudflare.com`)
- Go back to Hostinger → DNS settings → change nameservers to Cloudflare's
- Wait 1–24 hours for DNS to propagate
- Cloudflare auto-provisions free SSL

### A.3. Sign up for the hosts (~30 min total)

Create accounts on all of these now — verify email + payment method. Don't deploy yet.

- [ ] **Oracle Cloud** account at [oracle.com/in/cloud/free](https://www.oracle.com/in/cloud/free/) — verify Mumbai/Hyderabad as home region (free tier resources are region-locked, you can't move them later) — *OR* **DigitalOcean** at [digitalocean.com](https://www.digitalocean.com/) — pick Bangalore (BLR1) datacenter
- [ ] **Cloudflare Pages** (already done in A.2, just enable Pages on the dashboard)
- [ ] **Cloudflare R2** (file storage) — generate API token, save in 1Password
- [ ] **Sentry.io** — create project for each of: `foodflow-backend`, `foodflow-mobile`, `foodflow-dashboard`, `foodflow-admin`
- [ ] **Twilio** — Account SID, Auth Token, WhatsApp sender number
- [ ] **Razorpay** — KYC for live keys (this takes 2–3 days for verification with PAN, GSTIN, bank statement)
- [ ] **Resend.com** — for transactional email
- [ ] **Apple Developer Program** ($99) — only when ready to TestFlight
- [ ] **Google Play Console** ($25) — only when ready for internal testing

### A.4. Decide subdomains

| Subdomain | Points to | Used by |
|---|---|---|
| `foodflow.in` | Cloudflare Pages (marketing site) | Public landing page |
| `api.foodflow.in` | Render backend | Mobile + dashboard + admin |
| `app.foodflow.in` | Cloudflare Pages (dashboard) | Restaurant owners |
| `admin.foodflow.in` | Cloudflare Pages (admin) | Super-admin (you) |
| `qr.foodflow.in` | Cloudflare Pages (dashboard, /qr/* route) | Guest QR ordering |
| `status.foodflow.in` | UptimeRobot or BetterStack | Public uptime page |

DNS records will be set in Phase D.

---

## Phase B — Backend deployment

There are two paths. Pick one based on your time/money budget.

### Path B-Oracle: Oracle Cloud Mumbai (Always Free, ~4 hours setup)

#### B.1-Oracle. Provision the VM (30 min)

1. Sign in to Oracle Cloud Console → make sure home region is **Mumbai** or **Hyderabad**
2. Compute → Instances → Create Instance
3. Image: **Canonical Ubuntu 22.04** (ARM-compatible)
4. Shape: **VM.Standard.A1.Flex** — bump to 2 OCPU / 12 GB RAM (still within Always Free limit of 4 OCPU / 24 GB)
5. Networking: assign public IPv4
6. SSH keys: paste your `~/.ssh/id_ed25519.pub`
7. Create. Wait ~2 min for it to be RUNNING.
8. Note the **public IP**.

#### B.2-Oracle. Open firewall (10 min)

1. Networking → Virtual Cloud Networks → your VCN → default security list
2. Add ingress rules for ports 80 (HTTP), 443 (HTTPS) — source `0.0.0.0/0`
3. Inside the VM, also: `sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT && sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT && sudo netfilter-persistent save` (Oracle's Ubuntu image ships with iptables locked down)

#### B.3-Oracle. Install runtime (30 min)

```bash
ssh ubuntu@<your-ip>

# Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git nginx postgresql postgresql-contrib

# PM2 for process management
sudo npm install -g pm2

# Postgres setup
sudo -u postgres psql -c "CREATE USER foodflow WITH PASSWORD 'change-this-strong-password';"
sudo -u postgres psql -c "CREATE DATABASE foodflow OWNER foodflow;"
```

#### B.4-Oracle. Deploy backend (45 min)

```bash
# As ubuntu user
cd ~
git clone https://github.com/<you>/foodflow_backend.git
cd foodflow_backend
npm ci --omit=dev
cp .env.example .env
nano .env  # fill in DATABASE_URL=postgresql://foodflow:...@localhost:5432/foodflow + every other var
npm run migrate
pm2 start src/server.js --name foodflow-api
pm2 startup systemd  # follow the printed sudo command
pm2 save
```

#### B.5-Oracle. nginx reverse proxy + Let's Encrypt SSL (30 min)

```bash
sudo nano /etc/nginx/sites-available/foodflow
```

```nginx
server {
    listen 80;
    server_name api.foodflow.in;
    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/foodflow /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# SSL via Let's Encrypt
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.foodflow.in
```

After this `https://api.foodflow.in/v1/health` should return 200.

---

### Path B-DigitalOcean: DigitalOcean Bangalore ($4-6/mo, ~1 hour setup)

#### B.1-DO. Provision droplet (10 min)

1. DigitalOcean → Droplets → Create
2. Region: **Bangalore (BLR1)**
3. Image: Marketplace → **Node.js on Ubuntu 22.04** (pre-installs Node, nginx, PM2)
4. Plan: Basic Regular, $6/mo (1 vCPU / 1 GB RAM)
5. Authentication: SSH key
6. Hostname: `foodflow-prod`
7. Create. Wait ~1 min.

#### B.2-DO. App + DB

Follow steps B.3-Oracle, B.4-Oracle, B.5-Oracle (same scripts, just on DO). The Marketplace image already has Node + nginx + PM2 so you can skip the install steps and jump straight to the Postgres + git clone + nginx config.

DO also offers a **Managed Postgres** at $15/mo (Bangalore) if you don't want to self-host. Worth the cost once you have 3+ live customers.

---

### B.1. Provision managed Postgres on Render (15 min)

> ⚠️ **DEPRECATED** — Render's Singapore region is the only option, which fails DPDP cross-border requirements. This section is kept only for reference if you decide to override the India-region recommendation. **Default to Path B-Oracle or B-DigitalOcean above.**

1. Render dashboard → New → PostgreSQL
2. Plan: **Free** (1 GB, expires in 90 days) for beta, or **Starter** ($7/mo, persistent) once you have a real customer
3. Region: **Singapore** (lowest India latency, but outside India)
4. Name: `foodflow-prod-db`
5. Once created, copy:
   - Internal connection string (for backend → DB)
   - External connection string (for migrations from your laptop)

### B.2. Prepare backend code (1 hour)

You already have `foodflow_backend/`. Check these are set:

- [ ] `package.json` has `"start": "node src/server.js"` and `"engines": { "node": ">=18.0.0" }` ✓ (already there)
- [ ] `.env.example` lists every variable (create if missing — see template below)
- [ ] Health check at `/v1/health` returns 200 ✓ (already there)

Create `foodflow_backend/.env.example` (commit this, never commit `.env`):

```bash
# Database
DATABASE_URL=postgresql://user:pass@host:5432/foodflow

# Auth
JWT_SECRET=                                  # generate with: openssl rand -hex 64
JWT_REFRESH_SECRET=
GOOGLE_CLIENT_IDS=client-id-1.apps.googleusercontent.com,client-id-2

# Super-admin bootstrap
SUPER_ADMIN_EMAIL=admin@foodflow.in
SUPER_ADMIN_PASSWORD=                         # change before first run

# CORS
ALLOWED_ORIGINS=https://app.foodflow.in,https://admin.foodflow.in,https://foodflow.in

# Razorpay
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=

# Twilio (WhatsApp + SMS)
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_WA_FROM=whatsapp:+14155238886           # sandbox number for beta

# Email
RESEND_API_KEY=

# File uploads — Cloudflare R2
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=foodflow-uploads
R2_ACCOUNT_ID=

# Sentry
SENTRY_DSN=

# Rate limiting
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=1000

# App
NODE_ENV=production
PORT=4000
API_PREFIX=/v1
LOG_LEVEL=info
```

### B.3. Deploy backend (Render path, DEPRECATED)

See note above. If overriding to use Render:

1. Push `foodflow_backend/` to a GitHub repo (private)
2. Render dashboard → New → Web Service
3. Connect the GitHub repo
4. Settings:
   - **Region:** Singapore
   - **Branch:** `main`
   - **Root directory:** `foodflow_backend`
   - **Build command:** `npm install && npm run migrate`
   - **Start command:** `npm start`
   - **Plan:** Starter ($7/mo) — Free is sleep-on-idle and your customer's first POS request waits 30s for cold start
5. Add environment variables (copy from `.env.example`, fill in values)
6. `DATABASE_URL`: paste the **internal** Render Postgres URL
7. Deploy. First deploy takes ~5 min (npm install + migrations + boot).

### B.4. Verify backend live (5 min)

```bash
# Oracle/DO path
curl https://api.foodflow.in/v1/health
# → 200 {"ok": true, "db": "ok", "timestamp": "..."}
```

### B.5. Map custom domain — DNS (handled in Phase D)

For Oracle/DO: add an **A record** for `api.foodflow.in` → the VM's public IP, with proxy **off** (grey cloud) in Cloudflare. Let's Encrypt cert (set up in B.5-Oracle) takes over for SSL.

---

## Phase C — Frontend deployments (~1 hour total)

### C.1. Dashboard → Cloudflare Pages (15 min)

1. Cloudflare dashboard → Pages → Create a project → Connect GitHub
2. Pick your dashboard repo (or the `foodflow_dashboard` subfolder of the monorepo)
3. Build settings:
   - **Framework preset:** Vite
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
   - **Root directory:** `foodflow_dashboard` (if monorepo)
4. Environment variables (Production):
   ```
   VITE_API_URL=https://api.foodflow.in/v1
   VITE_SENTRY_DSN=<dashboard's Sentry DSN>
   ```
5. Deploy
6. Custom domain: `app.foodflow.in` (Pages shows the CNAME to add to Cloudflare DNS — but since it's same-zone, Cloudflare auto-wires it)

### C.2. Admin → Cloudflare Pages (15 min)

Repeat C.1 but for `foodflow_admin/`. Custom domain: `admin.foodflow.in`. Env:

```
VITE_API_URL=https://api.foodflow.in/v1
VITE_SENTRY_DSN=<admin's Sentry DSN>
```

### C.3. Marketing site (30 min)

You don't have one yet. Cheapest path:

**Option 1 — Notion site** (5 min, ugly but works)
- Make a Notion page describing the product
- Use **Super.so** or **Potion.so** to publish at `foodflow.in` (₹0–600/mo)

**Option 2 — Single-page HTML** (30 min, looks pro)
- I can scaffold this for you in a future message. One HTML file, Tailwind via CDN, hosted on Cloudflare Pages free
- Lives at `foodflow.in` root

For beta, Option 1 is fine. Pick Option 2 when you start asking for signups.

---

## Phase D — DNS map (after backend + frontend are deployed)

In Cloudflare DNS, you should end up with:

| Type | Name | Target | Proxy |
|---|---|---|---|
| CNAME | `@` (root) | `foodflow.pages.dev` (or Notion) | proxied |
| CNAME | `api` | Render service hostname | **DNS only** (grey cloud) |
| CNAME | `app` | `foodflow-dashboard.pages.dev` | proxied |
| CNAME | `admin` | `foodflow-admin.pages.dev` | proxied |
| CNAME | `qr` | Same as `app` | proxied |
| CNAME | `status` | UptimeRobot / BetterStack | proxied |
| MX | `@` | (defer until you need email) | — |
| TXT | `@` | SPF + DMARC (defer) | — |

**Why `api.foodflow.in` is "DNS only" (grey cloud):** Cloudflare's proxy buffers POST request bodies up to 100 MB and adds ~50ms latency. For an API serving mobile clients, you want the raw Render endpoint. Cloudflare still terminates SSL because of the CNAME.

---

## Phase E — Mobile deployment (~3 days first time, 30 min subsequent releases)

### E.1. iOS — TestFlight (Day 1)

1. Apple Developer Program: $99, takes 24–48 hrs for approval (have your Aadhaar / GSTIN / D-U-N-S ready)
2. App Store Connect → My Apps → New App → fill bundle ID matching `foodflow_flutter/ios/Runner.xcodeproj`
3. From your Mac:
   ```bash
   cd foodflow_flutter
   # Production build
   flutter build ios --release --dart-define=API_URL=https://api.foodflow.in/v1
   ```
4. Open `ios/Runner.xcworkspace` in Xcode → Product → Archive → Distribute → App Store Connect
5. Once it appears in App Store Connect (15–30 min processing), add it to TestFlight Internal Testing
6. Invite beta customers' Apple IDs to TestFlight; they get a link

### E.2. Android — Play Store internal testing (Day 1)

1. Google Play Console: $25 one-time
2. Create a new app in Play Console
3. Production-sign your APK/AAB (one-time keystore setup — keep this keystore safe forever, lose it and you can never update the app):
   ```bash
   keytool -genkey -v -keystore ~/foodflow-release.jks \
     -keyalg RSA -keysize 2048 -validity 10000 -alias foodflow
   ```
4. Configure `foodflow_flutter/android/key.properties` (don't commit):
   ```
   storePassword=…
   keyPassword=…
   keyAlias=foodflow
   storeFile=/Users/shiv/foodflow-release.jks
   ```
5. Build:
   ```bash
   flutter build appbundle --release --dart-define=API_URL=https://api.foodflow.in/v1
   ```
6. Upload the `.aab` to Play Console → Internal testing → add testers' Gmail accounts

### E.3. Pinning a build-time API URL

**Critical:** the mobile app's API URL is baked at compile time via `--dart-define=API_URL=...`. If you forget this flag, the app hits the default `https://api.foodflow.in/v1` (the default in `lib/services/api_service.dart`) — that already matches our domain so it's actually fine. But for staging builds use `--dart-define=API_URL=https://api-staging.foodflow.in/v1`.

---

## Phase F — Production hardening before first customer (~4 hours)

Do these BEFORE inviting beta customers. They're cheap insurance.

| | Item | Owner | Effort |
|---|---|---|---|
| ⬜ | Sentry SDK wired into backend + mobile + dashboard + admin (4 DSNs) | Shiv | 1h |
| ⬜ | UptimeRobot / BetterStack monitor pinging `/v1/health` every minute, alert via WhatsApp + email | Shiv | 30m |
| ⬜ | Render auto-deploy paused on `main` (manual deploy gate so untested code never reaches prod) | Shiv | 5m |
| ⬜ | Database backup cron also runs on prod (point `FF_BACKUP_DB`+`FF_BACKUP_HOST`+`FF_BACKUP_USER` env vars at the Render Postgres) | Shiv | 30m |
| ⬜ | Render Postgres → enable Point-In-Time Recovery (Standard plan and up) | Shiv | 5m |
| ⬜ | Manually create your super-admin account (`admin@foodflow.in`) once after first deploy | Shiv | 5m |
| ⬜ | Set ALLOWED_ORIGINS on backend to exactly `https://app.foodflow.in,https://admin.foodflow.in,https://foodflow.in` | Shiv | 5m |
| ⬜ | Razorpay live keys swapped from test → production after KYC clears | Shiv | 15m |
| ⬜ | Twilio WhatsApp sender approved (sandbox is fine for beta, but submit prod sender now — takes 5-10 days) | Shiv | 30m |
| ⬜ | Verify backend logs are reaching Render's log stream + Sentry | Shiv | 15m |
| ⬜ | Test the full signup flow on prod (you sign up, you create a menu, you place an order, you collect, you see the invoice) | Shiv | 30m |
| ⬜ | Test the full mobile flow on a real device (you log in, you place an order on the iPhone) | Shiv | 30m |

---

## Phase G — Launch day runbook (D-day)

### T-24 hours

- [ ] Backup the prod DB (manual)
- [ ] Verify Sentry is receiving test events from all 4 surfaces
- [ ] Verify UptimeRobot is pinging
- [ ] Verify Render is on Starter plan (not Free — Free sleeps on idle)
- [ ] Verify Cloudflare Pages builds are green
- [ ] Verify TestFlight + Play Internal Testing builds work
- [ ] Send the welcome doc + WhatsApp invite link to beta customer #1

### T-2 hours

- [ ] Final smoke test: full signup → menu → POS → collect → invoice → P&L on prod
- [ ] Open Render logs in one tab, Sentry dashboard in another, UptimeRobot in a third
- [ ] Have the backup + restore scripts handy in a terminal
- [ ] Coffee

### T-0 — first customer onboards

- [ ] WhatsApp video call (60 min, see `LAUNCH_PLAN.md` § "Customer onboarding playbook")
- [ ] Watch your logs in real-time
- [ ] Any Sentry alert during the call → pause, debug, log it in `LAUNCH_ISSUES.md`
- [ ] At end of call: confirm they can log in alone, sent them the WhatsApp support number

### T+24 hours

- [ ] WhatsApp check-in: "How was your first day?"
- [ ] Skim Sentry for new errors
- [ ] Check backup ran overnight (cron log)

### T+7 days

- [ ] First retro call (30 min)
- [ ] Top 3 wins + top 3 pains logged in `LAUNCH_ISSUES.md`
- [ ] Decide: pick the #1 pain → ship a fix this week → confirm fixed → next customer

---

## Phase H — Continuous ops (after launch)

### Weekly

- [ ] Review Sentry — triage new error groups
- [ ] Review Render metrics — CPU, memory, response times
- [ ] Review UptimeRobot — any outage > 60s gets a postmortem
- [ ] Skim backup log + verify log — both should be green
- [ ] Per-customer scorecard update in `LAUNCH_PLAN.md`

### Monthly

- [ ] Cost review — anything trending up?
- [ ] Cloudflare bandwidth — still in free tier?
- [ ] R2 storage — pruning old uploads if any?
- [ ] Twilio spend — proportional to orders?
- [ ] Render scaling — are you bumping CPU/memory limits?

### Per release (deploy a new version)

- [ ] Push to GitHub `main`
- [ ] Render: manual deploy (don't auto-deploy untested commits)
- [ ] Cloudflare Pages: auto-deploys on push
- [ ] Mobile: rebuild + new TestFlight / Internal Testing track
- [ ] Smoke-test the deploy on prod
- [ ] If anything regresses: Render → Rollback to previous deploy (one-click)

---

## Disaster runbooks

### Backend is down (UptimeRobot alerts)

1. Render dashboard → service → Events tab → find what caused the crash
2. Render → Logs → last 500 lines
3. If recent deploy caused it: Render → Rollback (1 click)
4. If DB issue: Render → Postgres → Logs
5. Confirm /v1/health returns 200 again
6. Notify affected customers via WhatsApp (you have their numbers)

### Database is wiped (god forbid, but it happened once)

1. Stop the backend (Render → service → Manual deploy → previous successful build)
2. `./scripts/restore-db.sh <latest-backup>` from your local machine, targeting `foodflow_restore`
3. Verify counts in `foodflow_restore`
4. Update Render env var `DATABASE_URL` to point to `foodflow_restore`
5. Restart backend
6. After confidence: rename `foodflow_restore` → `foodflow` and revert the env var

### Razorpay webhook fails

1. Check `/v1/billing/razorpay-webhook` route in Render logs
2. Verify `RAZORPAY_WEBHOOK_SECRET` env var matches Razorpay dashboard
3. Replay the webhook from Razorpay dashboard → Webhook Events → Replay

---

## Cost-control tips

- **Use Render's free tier for the database during beta** — but understand it expires in 90 days and is 1 GB max. Move to Starter ($7/mo, persistent, daily backup) before you onboard customer #6.
- **Cloudflare Pages is unlimited free.** Don't move to Vercel unless you need its features.
- **Twilio WhatsApp** — sandbox is free for 1:1 testing but won't scale. Production WhatsApp Business sender is ~₹0.5/message. Budget assumes ~500 messages/customer/month.
- **Render → Auto-deploy off, Manual deploy on.** Saves you when a bad commit lands on `main`.
- **Don't pre-pay for a year on any host** until you've been live for 3 months. Variance in early-stage is real.

---

## What I (the AI) can do for you

Tell me which item and I'll write code/configs:

1. **Setup wizard** for first-time customers (mobile + dashboard) — 1 day
2. **Sentry init** code for all 4 surfaces — 2 hours
3. **Health-check expansion** (`/v1/health` returning DB + cache + Twilio status) — 1 hour
4. **`render.yaml`** infrastructure-as-code for the backend service — 30 min
5. **Backup-on-prod cron** runbook (different env vars from local) — 30 min
6. **Single-page marketing site** HTML — 2 hours
7. **Mobile splash + login polish** for the App Store screenshots — 2 hours
8. **Status page** integration with BetterStack / UptimeRobot — 30 min
9. **Disaster-recovery runbook** as a separate doc — 30 min
10. **Razorpay webhook signature verification** test + Sentry alert if it ever fails — 1 hour

---

## Estimated time end-to-end (solo founder)

| Phase | Hours |
|---|---:|
| A. Pre-flight (accounts + domain) | 3 |
| B. Backend deploy | 1.5 |
| C. Frontend deploys (dashboard + admin) | 1 |
| D. DNS map | 0.5 |
| E. Mobile (Apple + Google + builds) | 8 (first time) |
| F. Production hardening | 4 |
| G. Launch day | 4 |
| **Total to live with first customer onboarded** | **~22 hours** = 3 focused days |

Plus 2–3 days waiting for Apple/Google approvals and Razorpay KYC.

**Realistic calendar:** sign up for accounts today, deploy backend + frontend tomorrow, mobile builds Wednesday, hardening Thursday, **first customer Friday**.

---

## Sign-off

This deployment plan stays valid until you have ≥ 50 paying customers. At that scale rework needed:

- Backend: scale up Render plan + add second instance behind load balancer (Render auto-scaling tier)
- DB: move from Render Postgres → Aiven / AWS RDS / Crunchy Bridge for managed HA
- CDN: enable Cloudflare proxy on `api.foodflow.in` once we've audited request sizes
- File storage: move from R2 to S3 if you need bigger free tier
- Monitoring: pay for Sentry Team plan (₹2,000/mo)
- On-call: 2nd engineer with rotation
