---
tags: [namastepos, entitlements]
---
# Feature Registry and Gating

`namastepos_backend/src/config/featureRegistry.js` is the **only** list of feature keys (52 as of 2026-09-06). Each entry: `key`, `label`, `group`, `enforcement`, and `clients`/`why`.

| enforcement | meaning | proof the audit demands |
|---|---|---|
| `route` | a `FEATURE_RULES` row in `featureGate.js` (substring on `req.path`, first match wins, `/addons` always open) | rule must match ≥1 real Express route (`featureRuleCoverage2026.test.js` walks the router) |
| `middleware` | `requireFeature(key)` on a route | grep |
| `service` | `hasFeature()` inside a service | grep |
| `client` | no server surface; `clients: ['dashboard'\|'mobile']` must check the key | dashboard `lib/navConfig.ts` / mobile `lib/constants/feature_keys.dart` string match |
| `ungated` | granted by plans, enforced nowhere — a known gap, must carry `why` | frozen set in `scripts/feature-registry-audit.js` |

Four things must agree, and CI fails when they don't (`featureRegistryDrift.test.js`, `featureRuleCoverage2026.test.js`, `entitlementGates2026.test.js`): the registry, `featureGate` rules, `plan_features` rows, and the two client registries.

## How a key resolves (`featureService.hasFeature`)
plan_features for the tenant's plan **∪** addon `grants_features` (active AND `current_period_end > NOW()`) **±** per-business overrides. Subscription must be `active`, unexpired `trialing`, or `past_due` inside grace; everything else (cancelled, paused, `suspended`, lapsed) falls to Starter. Cached 60 s, invalidated on every write path + Redis pub/sub; `planVersion` fingerprint → `X-Plan-Version` header.

**No tier_kind fallback when the kind string is also a plan code** — kind `pro` (Growth) collides with Enterprise's code `pro`; an empty plan used to inherit all 51 Enterprise keys ([[Tier Code Trap]]).

## Admin
Picker reads `GET /v1/admin/feature-catalog` = `registry.catalog()` ∪ stray `plan_features` keys (badged `unregistered`). Unknown keys are rejected on tier-features, overrides, custom plans and addon grants (`assertKnownFeatureKeys`). `pos` cannot be removed. Limits are `int ≥ -1`, known names only.

## Adding a feature key
1. Add the registry entry. 2. Add the actual gate (rule / requireFeature / client check). 3. Nothing else — admin, custom plans, overrides, addon grants all read the registry. If it is `client`, add the check in the named client(s) or the drift test fails.

## Keys sold but delivering nothing (founder decision pending)
`recurring_invoices`, `api_access`, `white_label`, `marketplace_addons`, `customers_crm`, `dashboard_access` — see `why` in the registry and [[Code Review 2026-09-05]].
