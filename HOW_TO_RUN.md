# NamastePOS SaaS — full stack run guide

You have **three layers + one mobile app**:

```
┌──────────────────────────────────────────────────────────────┐
│ admin.namastepos.in  (namastepos_admin)    React + Vite          │  Super admin panel
└──────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────┐
│ app.namastepos.in    (namastepos_dashboard) React + Vite         │  Customer dashboard
└──────────────────────────────────────────────────────────────┘
                                ↓
┌──────────────────────────────────────────────────────────────┐
│ api.namastepos.in    (namastepos_backend)   Node.js + Postgres   │  REST API
└──────────────────────────────────────────────────────────────┘
                                ↑
┌──────────────────────────────────────────────────────────────┐
│ Mobile app        (namastepos_flutter)    Android + iOS POS    │  Counter terminal
└──────────────────────────────────────────────────────────────┘
```

## 0️⃣ One-time: Google OAuth + Razorpay setup (~10 min)

### Google
https://console.cloud.google.com/apis/credentials → create **three** OAuth 2.0 Client IDs:

| Type | Settings | Save the ID |
|---|---|---|
| Web Application | Authorized JS origins: `http://localhost:5173`, `http://localhost:5174` | **Web Client ID** |
| Android | Package: `in.namastepos.app`, SHA-1 from your debug keystore (see below) | Android Client ID |
| iOS | Bundle ID: `in.namastepos.app` | iOS Client ID + reversed iOS ID |

Get your Android SHA-1:
```bash
keytool -list -v -keystore ~/.android/debug.keystore \
  -alias androiddebugkey -storepass android -keypass android | grep SHA1:
```

### Razorpay
https://dashboard.razorpay.com/app/keys → generate test keys. Note `Key ID` and `Key Secret`.

Add a webhook at https://dashboard.razorpay.com/app/webhooks pointing to
`https://your-api-host/v1/webhooks/razorpay`. Pick events: `subscription.activated`,
`subscription.charged`, `subscription.cancelled`, `subscription.paused`,
`subscription.halted`, `payment.failed`. Note the webhook secret.

## 1️⃣ Configure the stack

```bash
cd "~/AI Development/Java Projects/PetPooja Clone"
cp .env.example .env
```

Edit `.env`:

```env
JWT_SECRET=<openssl rand -base64 48>
GOOGLE_CLIENT_IDS=WEB.apps.googleusercontent.com,ANDROID.apps.googleusercontent.com,IOS.apps.googleusercontent.com
GOOGLE_WEB_CLIENT_ID=WEB.apps.googleusercontent.com
RAZORPAY_KEY_ID=rzp_test_xxx
RAZORPAY_KEY_SECRET=xxx
RAZORPAY_WEBHOOK_SECRET=xxx
SUPER_ADMIN_EMAIL=admin@namastepos.in
SUPER_ADMIN_PASSWORD=<pick a strong one>
```

## 2️⃣ Bring everything up

```bash
docker-compose up -d
docker-compose exec api npm run migrate
docker-compose ps   # all five should show "healthy"
```

Five services come up:

| Service | URL | What you get |
|---|---|---|
| Backend API | http://localhost:4000/v1 | REST endpoints |
| Postgres | localhost:5432 | Database (user `namastepos` / pass `namastepos`) |
| Redis | localhost:6379 | Cache + future job queue |
| Super admin panel | http://localhost:5173 | Login with `SUPER_ADMIN_EMAIL`/`PASSWORD` |
| Customer dashboard | http://localhost:5174 | Sign in with Google |

Stream logs:
```bash
docker-compose logs -f api admin dashboard
```

## 3️⃣ Sync plans with Razorpay (one-time)

After first boot, log into the super-admin panel → **Plans** → click **Sync Razorpay plans**. This creates the Basic / Pro plans in your Razorpay account so paid subscriptions can attach to real plan IDs.

You can also do it via API:
```bash
TOKEN=<your admin JWT from logging in>
curl -X POST http://localhost:4000/v1/admin/razorpay/sync \
  -H "Authorization: Bearer $TOKEN"
```

## 4️⃣ Run the mobile app (separate from docker-compose)

```bash
cd namastepos_flutter
chmod +x setup.sh && ./setup.sh    # one-time scaffolding
flutter run \
  --dart-define=API_URL=http://10.0.2.2:4000/v1 \
  --dart-define=GOOGLE_WEB_CLIENT_ID=<your-web-client-id>.apps.googleusercontent.com
```

For iOS simulator use `API_URL=http://localhost:4000/v1`.
For a physical device use `API_URL=http://192.168.x.x:4000/v1` (your Mac's LAN IP via `ipconfig getifaddr en0`).

## 🎯 What the workflow looks like end-to-end

1. **Customer signs up**: A restaurant owner opens the customer dashboard at `localhost:5174` → signs in with Google → backend creates `users` row + `businesses` row + free `subscription` (14-day trial) → owner lands on Dashboard.
2. **Customer onboards staff**: Owner goes to **Staff** → invites a cashier by email → copies the accept-link → cashier follows the link, signs in with their Google → they're added as `staff_cashier`.
3. **Counter takes orders**: Cashier opens the mobile app on the counter tablet → signs in with the same Google → POS interface, takes orders, prints tokens.
4. **Owner watches from laptop**: Customer dashboard's **Orders** tab auto-refreshes every 5 sec, showing the same orders live.
5. **Owner upgrades plan**: Trial ending → mobile app shows banner → owner taps it → goes to dashboard → Billing → Switch to Basic → Razorpay checkout opens → pays → webhook fires → subscription becomes `active`.
6. **Platform owner monitors**: You log into `localhost:5173` super admin → see this customer in the Customers list, with their MRR contribution, plan, and order volume.

## 📂 Folder structure

```
PetPooja Clone/
├── .env.example                 ← root SaaS config (for docker-compose)
├── docker-compose.yml           ← brings up all 5 services
├── HOW_TO_RUN.md                ← this file
│
├── namastepos_backend/            ← Node.js + Express + Postgres (REST API)
│   ├── src/                       40 .js files: services, controllers, routes
│   ├── db/migrations/
│   │   ├── 001_init_schema.sql    Core tables (businesses, menu, orders, …)
│   │   └── 002_saas_schema.sql    SaaS tables (users, plans, subs, invoices, …)
│   ├── tests/                     Jest + Supertest, 5 suites
│   ├── Dockerfile + docker-compose.yml (standalone)
│   └── README.md                  API reference
│
├── namastepos_admin/              ← Super admin panel (you)
│   ├── src/pages/  (Login, Dashboard, Customers, CustomerDetail, Plans, Metrics)
│   ├── src/api/admin.ts
│   └── ...
│
├── namastepos_dashboard/          ← Customer dashboard (each restaurant owner)
│   ├── src/pages/  (Login, Dashboard, Menu, Orders, Expenses, Reports, Staff, Billing, Settings)
│   ├── src/api/namastepos.ts
│   └── ...
│
└── namastepos_flutter/            ← Mobile POS (Android + iOS)
    ├── lib/  (~7,400 LOC, 54 .dart files)
    ├── android/  ios/
    └── setup.sh
```

## 🛣 Production deployment (when you're ready)

| Layer | Where it goes | Why |
|---|---|---|
| Backend API | AWS Elastic Beanstalk / DigitalOcean App Platform / Google Cloud Run | Stateless Node container, just needs a Postgres + Redis attached |
| Postgres | AWS RDS / Supabase / Neon / Google Cloud SQL | Managed Postgres 14+, daily backups |
| Redis | AWS ElastiCache / Upstash | Cache + future job queue |
| Super admin panel | Vercel / Netlify (build with `npm run build`, deploy `dist/`) | Static site, set `VITE_API_URL=https://api.namastepos.in/v1` at build time |
| Customer dashboard | Vercel / Netlify | Same as above, plus `VITE_GOOGLE_CLIENT_ID` |
| Mobile app | Play Store + App Store via Flutter `build appbundle` / `build ipa` | Sign with your release keystore + Apple Developer account |

## 🆘 Common gotchas

| Problem | Fix |
|---|---|
| Admin panel says "Cannot connect to API" | `docker-compose logs api` — check it's listening on :4000. Make sure `VITE_API_URL` is set on `admin` service. |
| Google sign-in works on web, fails on mobile | Add Android & iOS Client IDs to `GOOGLE_CLIENT_IDS` (not just Web). |
| `make_interval` SQL error on reports | You're not on Postgres 14+. Upgrade or rewrite that one query. |
| Razorpay `Plan not synced` error when subscribing | Click **Sync Razorpay plans** in admin panel. |
| Mobile app's banner says "Trial ends in 0 days" right after sign-up | Check Postgres clock vs. your laptop clock — they should agree. |

## 🧪 Quick smoke test (sanity check the full pipeline)

```bash
# 1. API alive?
curl http://localhost:4000/v1/health

# 2. Plans available?
curl http://localhost:4000/v1/plans

# 3. Admin login
curl -X POST http://localhost:4000/v1/admin/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@namastepos.in","password":"YOUR_PASSWORD"}'

# 4. Admin sees zero customers (yet)
TOKEN=<token from step 3>
curl http://localhost:4000/v1/admin/customers \
  -H "Authorization: Bearer $TOKEN"
```

Then in a browser:
1. http://localhost:5173 → log in as admin
2. http://localhost:5174 → sign in with Google → a new customer appears in your admin panel within seconds.
3. `flutter run --dart-define=…` → sign in with the SAME Google account → mobile shows the same business.

If all three see the same business, the whole stack is wired correctly.
