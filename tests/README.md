# NamastePOS — End-to-End Tests

Playwright-based happy-path coverage for the customer dashboard
(`namastepos_dashboard` @ http://localhost:5174) and its backend
(`namastepos_backend` @ http://localhost:4000).

Specs map to the major flows the user touches every day:

| Spec file                       | What it covers                                            |
| ------------------------------- | --------------------------------------------------------- |
| `01-login.spec.ts`              | Email + password login → land on the overview dashboard   |
| `02-menu.spec.ts`               | Menu list loads, item edit dialog opens, save sticks      |
| `03-place-order.spec.ts`        | POS new order → KOT generated → status flips to collected |
| `04-reports-pnl.spec.ts`        | P&L tab renders, date range works, PDF/XLSX/CSV export    |
| `05-reports-registers.spec.ts`  | Income / Expense / Invoice register tabs render + export  |
| `06-tax-invoices.spec.ts`       | Tax invoices auto-issued on order collect; PDF print      |
| `07-qr-codes.spec.ts`           | QR cards render, PNG download, guest menu loads + orders  |
| `08-staff.spec.ts`              | Add staff with PIN, over-limit banner + comply-now action |
| `09-billing.spec.ts`            | Plan compare cards driven by /plans endpoint              |
| `10-admin-login.spec.ts`        | Super-admin login + bad-credential rejection              |
| `11-admin-customers.spec.ts`    | Customer detail tabs, addons safety, bulk import, exports |
| `12-admin-reports.spec.ts`      | Platform P&L, Customer KPIs, Revenue split chart          |
| `13-admin-finance.spec.ts`      | Finance KPIs, outstanding aging buckets, CSV exports      |
| `14-admin-audit-modules.spec.ts`| Audit dropdown includes `addons` + `menu` modules         |

## Running the suites

Both suites share one config. The `dashboard` project targets the owner app
at `FF_BASE_URL` (default `http://localhost:5174`); the `admin` project
targets the super-admin at `FF_ADMIN_URL` (default `http://localhost:5173`).

```bash
# Run everything
pnpm exec playwright test

# Just dashboard tests (specs 01-09)
pnpm exec playwright test --project=dashboard

# Just super-admin tests (specs 10-14)
pnpm exec playwright test --project=admin

# Override base URLs if your dev servers run elsewhere
FF_BASE_URL=http://localhost:5174 \
  FF_ADMIN_URL=http://localhost:5173 \
  pnpm exec playwright test
```

For the admin suite, also set `FF_ADMIN_EMAIL` and `FF_ADMIN_PASSWORD` —
defaults to `admin@namastepos.in` / `admin123`.

## Prerequisites

1. **Backend running** on `http://localhost:4000` with
   `npm run migrate` applied through 037 and a seeded business
   (the existing Sugar & Spice owner works fine).
2. **Dashboard running** on `http://localhost:5174` (`npm run dev`
   inside `namastepos_dashboard/`).
3. **A test owner account** — the specs default to the env vars
   `FF_OWNER_EMAIL` + `FF_OWNER_PASSWORD`. If unset, they fall back
   to your existing `shivlokhande7080@gmail.com` test account.

## Install + run

```bash
# from the repo root
cd tests
npm install
npx playwright install   # one-time: downloads browser binaries
npm test                 # all specs, headless
npm run test:headed      # watch the browser drive the UI
npm run test:ui          # interactive picker / time-travel
```

## TestSprite integration

These specs ARE the test plan TestSprite will run. Once you've added
TestSprite as a Cowork MCP (see `TESTSPRITE_SETUP.md` in this folder),
ask Claude:

> "Run all NamastePOS specs through TestSprite and summarize failures"

TestSprite reads `playwright.config.ts` to discover the suites, then
executes each spec in an isolated browser context, posts the trace
back to its dashboard, and surfaces a structured pass/fail list back
to Claude.

## Environment variables

| Variable             | Default                          | Purpose                       |
| -------------------- | -------------------------------- | ----------------------------- |
| `FF_BASE_URL`        | `http://localhost:5174`          | Dashboard origin              |
| `FF_API_URL`         | `http://localhost:4000/v1`       | Backend API origin            |
| `FF_OWNER_EMAIL`     | `shivlokhande7080@gmail.com`     | Test owner login              |
| `FF_OWNER_PASSWORD`  | `password123`                    | Test owner password           |
| `FF_BUSINESS_ID`     | `62512465-6a63-49b4-82dc-9a9d387ac55e` | Sugar & Spice fixture     |
