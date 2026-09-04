# CI E2E — the money path + staff RBAC

Two specs, run on every PR by the `e2e` job in `.github/workflows/ci.yml`.
They are deliberately **thin**: this is not broad coverage (that lives in
`../specs/`), it is a gate on the two things that must never regress silently.

| Spec | Guards |
| --- | --- |
| `money-flow.spec.ts` | owner logs in → takes an order in the POS → the order shows the correct **server-computed** total → settles it → the day's revenue reflects it. Plus an API-level check that the server prices from `menu_items.price` and ignores a client-supplied `price`. |
| `staff-rbac.spec.ts` | a `staff_kitchen` login is refused the team roster, the daily report and the P&L. See the header comment — the **web sidebar half of this bug is still open** and that assertion is quarantined with `test.fixme`. |

## Why it is a separate Playwright project

These live in the existing `tests/` package (same `@playwright/test`
dependency, same `playwright.config.ts`) as the **`ci-e2e` project**. Unlike the
`dashboard` / `admin` projects they have **no `dependencies` and no
`storageState`**: each test registers its own business over `/auth/register`, so
the suite runs against a blank database and no test reads data another test
created. That is the single biggest source of E2E flake, and it is designed out
rather than retried away.

## Running it locally

```bash
# 1. backend on :4000 against a DB you don't mind writing to
cd namastepos_backend && npm run migrate && npm start

# 2. dashboard — built + previewed, the same artifact CI tests
cd namastepos_dashboard
VITE_API_URL=http://localhost:4000/v1 npm run build
npm run preview            # serves :5174

# 3. the suite
cd tests && npm ci && npx playwright install --with-deps chromium
E2E_API_URL=http://localhost:4000/v1 \
E2E_DASHBOARD_URL=http://localhost:5174 \
  npx playwright test --project=ci-e2e
```

`npx playwright test` with no `--project` also runs the older `./specs` suites,
which need a pre-seeded tenant. Always pass `--project=ci-e2e` for this one.

| Env var | Default | Purpose |
| --- | --- | --- |
| `E2E_API_URL` | `http://localhost:4000/v1` | Backend origin **including** `/v1`. Used by the seeding helpers. |
| `E2E_DASHBOARD_URL` | falls back to `FF_BASE_URL`, then `http://localhost:5174` | Where the built dashboard is served. |

## House rules for anything added here

- **No `waitForTimeout`.** Web-first assertions (`expect(locator).toBeVisible()`)
  and explicit `waitForResponse` on the mutation you care about. A sleep is a
  race you decided not to look at.
- **Seed your own tenant.** Call `makeBusiness()` in `beforeEach`. Never rely on
  a business, menu item or order another spec created.
- **Never `page.reload()`.** The dashboard holds its access token in a
  module-level variable (`src/api/client.ts`), not in `localStorage`; surviving a
  reload depends on the httpOnly `ff_refresh` cookie being replayed across two
  plain-http ports, which is not dependable. Navigate via in-app links, which is
  what a real cashier does anyway.
- **Pin exact money.** Seed items at `gstPct: 0` so the expected total is a
  constant, not a function of the tenant's round-off / service-charge /
  discount-is-pre-tax settings. Assert the number the **server** persisted, read
  back from the API — the UI figure is a second opinion, not the source of truth.
- **Locators:** the dashboard has essentially no `data-testid`, and `<Label>` is
  not associated with `<Input>` via `htmlFor`, so `getByLabel()` does not work.
  Use roles, placeholders and `autocomplete` attributes.

## Traces

`use.trace` is `retain-on-failure` for the whole config, and the CI job uploads
`tests/test-results/` and `tests/playwright-report/` as artifacts on failure.
Open one with:

```bash
cd tests && npx playwright show-trace test-results/<...>/trace.zip
```
