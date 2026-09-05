# NamastePOS Backend

Multi-tenant POS API for NamastePOS. **Node.js 18 + Express + PostgreSQL 14**.
Authentication is **Google Sign-In** (we'll layer Twilio OTP back on later
without touching the rest of the API).

```
namastepos_backend/
├── package.json
├── .env.example
├── Dockerfile + docker-compose.yml
├── src/
│   ├── server.js                 ← bootstrap
│   ├── app.js                    ← Express factory
│   ├── config/  (env, logger, db)
│   ├── middleware/  (auth, validate, errorHandler)
│   ├── services/   (googleService, authService, menuService, orderService,
│   │                expenseService, reportService)
│   ├── controllers/  (auth, menu, order, expense, reports)
│   ├── routes/     (5 routers)
│   └── utils/  (errors, asyncHandler, jwt, tokenPrinter)
├── db/migrations/001_init_schema.sql      ← 10 tables, ENUMs, indexes, triggers
├── scripts/migrate.js                     ← simple SQL migration runner
└── tests/  (Jest + Supertest, 4 suites)
```

## ✅ Quick start

### Prereqs
- Node.js 18+
- Docker + Docker Compose (or local Postgres 14)
- A Google Cloud project with OAuth 2.0 client IDs

### 1. Configure Google OAuth (one-time)

1. Go to https://console.cloud.google.com/apis/credentials
2. Create OAuth 2.0 Client IDs for each platform you'll ship:
   - **Web Client ID** — used as the audience the backend verifies. Required.
   - **Android Client ID** — package `in.namastepos.app`, SHA-1 fingerprint from your debug + release keystores
   - **iOS Client ID** — bundle id `in.namastepos.app`
3. Copy the *Web Client ID* (and optionally also Android/iOS) into `.env`:

   ```env
   GOOGLE_CLIENT_IDS=YOUR-WEB-CLIENT-ID.apps.googleusercontent.com,YOUR-ANDROID-CLIENT-ID.apps.googleusercontent.com,YOUR-IOS-CLIENT-ID.apps.googleusercontent.com
   ```

   The Flutter app passes the *server* client ID as `serverClientId` to the
   `google_sign_in` plugin so the issued ID token's audience matches.

### 2. Run locally (Docker — easiest)

```bash
cp .env.example .env
# edit .env: set JWT_SECRET, GOOGLE_CLIENT_IDS
docker-compose up -d
docker-compose exec api npm run migrate
curl http://localhost:4000/v1/health
# → { "status": "ok", "service": "namastepos-api", ... }
```

### 3. Run locally (without Docker)

```bash
# 1) start Postgres however you like, e.g. via brew or your usual installer
createdb namastepos

# 2) install + configure
npm install
cp .env.example .env  # fill in DATABASE_URL, JWT_SECRET, GOOGLE_CLIENT_IDS

# 3) migrate + run
npm run migrate
npm run dev
```

### 4. Run tests

```bash
createdb namastepos_test
NODE_ENV=test npm test
```

The test suite:
- Auth flow (Google sign-in stub, JWT refresh rotation)
- Menu CRUD (incl. stock adjustments + tenant isolation)
- Orders (creation, idempotency via `clientId`, status transitions, receipt rendering)
- Expenses + daily/monthly P&L reports
- Token receipt formatter (unit)

```
> jest --runInBand
PASS tests/unit/tokenPrinter.test.js
PASS tests/integration/auth.test.js
PASS tests/integration/menu.test.js
PASS tests/integration/orders.test.js
PASS tests/integration/expenses-reports.test.js
```

## 📡 API surface

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/auth/google`         | Exchange Google idToken → `{token, refreshToken, business}` |
| POST | `/v1/auth/refresh`        | Rotate refresh token, get new JWT |
| POST | `/v1/auth/logout`         | Revoke a refresh token (auth required) |
| GET  | `/v1/auth/me`             | Current business |
| PATCH | `/v1/auth/me`            | Update business profile / onboarding |
| GET  | `/v1/businesses/:bid/menu` | List menu items |
| POST | `/v1/businesses/:bid/menu` | Create menu item |
| PUT  | `/v1/businesses/:bid/menu/:itemId` | Update |
| DELETE | `/v1/businesses/:bid/menu/:itemId` | Soft-delete |
| PUT  | `/v1/businesses/:bid/menu/:itemId/stock` | Adjust stock (logs `inventory_transactions`) |
| GET  | `/v1/businesses/:bid/menu/:itemId/history` | Stock movement log |
| POST | `/v1/businesses/:bid/orders`   | Create order (idempotent via `clientId`, atomic stock deduction) |
| GET  | `/v1/businesses/:bid/orders`   | List orders (filter by date/status) |
| GET  | `/v1/businesses/:bid/orders/:orderId` | Order detail |
| PUT  | `/v1/businesses/:bid/orders/:orderId/status` | pending → ready → collected/cancelled |
| POST | `/v1/businesses/:bid/orders/:orderId/print`  | Generate ESC/POS receipt text + mark printed |
| POST | `/v1/businesses/:bid/expenses` | Create expense |
| GET  | `/v1/businesses/:bid/expenses` | List (filter by `startDate`, `endDate`, `category`) |
| DELETE | `/v1/businesses/:bid/expenses/:expenseId` | Soft-delete |
| GET  | `/v1/businesses/:bid/reports/daily?date=YYYY-MM-DD`  | Daily P&L (revenue by source, expenses by category, top items) |
| GET  | `/v1/businesses/:bid/reports/monthly?month=YYYY-MM`  | Monthly P&L with daily series |
| GET  | `/health` | Shallow liveness probe (no DB) + build marker |
| GET  | `/v1/health` | Deep health — pings the DB (503 `degraded` if wedged) + build marker |

### Verifying a deploy from outside

Both health endpoints carry the deployed build marker, so "did my push go
live?" is answerable without opening the Render dashboard:

```bash
curl -s https://api.namastepos.in/v1/health | jq -r '.commit, .branch, .startedAt'
# efe5691
# main
# 2026-09-05T09:14:02.118Z
```

`commit` is the short SHA from Render's auto-injected `RENDER_GIT_COMMIT`
(`GIT_COMMIT` works too for non-Render builds); it degrades to `"unknown"`
locally, in tests and in CI where no such var exists — the field is always
present. `startedAt` / `uptimeSeconds` make a restart visible even when the
commit is unchanged. See `src/config/buildInfo.js`.

All non-`/auth` endpoints require `Authorization: Bearer <jwt>` and enforce
*tenant isolation* — the `:bid` in the URL must match the authenticated
business or you get `403`.

## 🔐 Auth flow

```
┌──────────┐   1. Open Google picker   ┌──────────────┐
│ Flutter  │  ────────────────────────►│ Google OAuth │
│   app    │   2. ID token (audience=  └──────┬───────┘
│          │      web client id)              │
│          │  ◄───────────────────────────────┘
│          │
│          │   3. POST /v1/auth/google { idToken }
│          │  ──────────────────────────────────► ┌──────────────┐
│          │                                       │   Backend    │
│          │   4. google-auth-library              │ google-auth- │
│          │      verifies signature +             │ library      │
│          │      audience + email_verified  ◄────│              │
│          │                                       │              │
│          │   5. find_or_create_business(sub,email)              │
│          │      → row in `businesses`            │              │
│          │   6. issue JWT (30 min) +             │              │
│          │      refresh token (30 days,          │              │
│          │      stored as sha256 hash)           │              │
│          │  ◄───────────────────────────────── { token,         │
│          │                                       refreshToken,  │
│          │                                       business }     │
└──────────┘                                       └──────────────┘
```

- JWTs are signed HS256 with `JWT_SECRET`. Every `jwt.verify` in the codebase
  pins `algorithms: ['HS256']` — `src/utils/jwt.js` (tenant + admin sessions)
  and `src/services/qrService.js` (table QR tokens).
- Refresh tokens are 48-byte random strings; only their SHA-256 hash is
  stored, so a database leak doesn't yield usable tokens.
- Refresh rotates on every use; the old token is revoked.
- **Tenant clients (mobile app, tenant dashboard) authenticate with
  `Authorization: Bearer`. The platform admin console authenticates with the
  httpOnly `ff_admin` cookie ONLY** — `requireSuperAdmin` does not accept a
  Bearer header (2026-09-04). There is deliberately no localStorage fallback:
  the admin JWT must never be reachable from JavaScript.

### Security-relevant env vars

| Var | Required? | Generate with | If unset |
|---|---|---|---|
| `JWT_SECRET` | yes (prod boot fails) | `openssl rand -base64 48` | boot fails |
| `TOTP_ENC_KEY` | strongly recommended | `openssl rand -base64 32` | admin 2FA KEK falls back to being derived from `JWT_SECRET`, so rotating `JWT_SECRET` permanently breaks every admin's 2FA. Boot warns, never fails. |
| `REDIS_URL` | required for >1 instance | (Upstash / Render Key Value URL) | staff-permission, admin-role and plan-feature caches invalidate on the local instance only; other instances wait out a 30–60s TTL |

`TOTP_ENC_KEY` is backward compatible. Ciphertexts written under the old
JWT-derived key have no prefix and are still readable; new ones are stored as
`v2:<base64>` and are re-encrypted lazily the next time each admin
successfully uses a 2FA code. Migration progress:

```sql
SELECT count(*) FROM admin_users
 WHERE totp_secret_enc IS NOT NULL AND totp_secret_enc NOT LIKE 'v2:%';
```

## 🗄 Database schema

10 tables. See `db/migrations/001_init_schema.sql` for the full DDL.
The most important constraints:

- `businesses.google_sub` and `businesses.email` are UNIQUE → one Google account = one business.
- `orders` has `UNIQUE(business_id, client_id)` so a mobile retry never duplicates.
- `orders.status` is a Postgres ENUM (`pending|ready|collected|cancelled`).
- All money columns use `NUMERIC(10,2)` to avoid float drift.
- `inventory_transactions` is append-only — full audit trail of every stock movement.

## 🚀 Deploy

The image is small (~80 MB) and stateless. Push it to ECR / DockerHub:

```bash
docker build -t namastepos-api .
docker tag namastepos-api YOUR-REGISTRY/namastepos-api:latest
docker push YOUR-REGISTRY/namastepos-api:latest
```

…then deploy on AWS Elastic Beanstalk, ECS Fargate, Google Cloud Run, or
plain DigitalOcean App Platform. All you need is:
- a Postgres 14 instance (managed RDS / Neon / Supabase / Cloud SQL)
- the env vars listed in `.env.example`

## 🛣 Roadmap (next sprint)

1. Swap Google for **Twilio Verify OTP** (`/auth/request-otp` + `/auth/verify-otp`) once the trial credit lands.
2. **WebSocket** push for live order queue (Socket.IO with sticky sessions).
3. **Background sync worker** for the Flutter offline queue (Redis-backed BullMQ).
4. **Zomato / Swiggy webhook receivers** under `/v1/webhooks/{zomato,swiggy}`.
5. **Excel / PDF export** for monthly reports (`exceljs` and `pdfkit` already installed).
