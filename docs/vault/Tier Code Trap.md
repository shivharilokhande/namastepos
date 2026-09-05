---
tags: [namastepos, trap]
---
# Tier Code Trap

`plans.tier` (the **code**) and `plans.tier_kind` (the **kind**) are different vocabularies and they collide:

| Plan | code (`plans.tier`) | kind (`tier_kind`) | ₹/mo |
|---|---|---|---|
| Starter | `free` | `starter` | 0 |
| Growth | `basic` | **`pro`** | 299 |
| Pro | `pro_plan` | — | 799 |
| Advanced | `advanced` | — | 999 |
| **Enterprise** | **`pro`** | `enterprise` | — |

`src/config/planTiers.js` is the source of truth. **Never gate on a tier code — gate on the feature key.** Never decide "free vs paid" on `tier === 'free'` — use `isFreePlan(plan)` (price). Show codes with labels in any UI ("Enterprise · db tier: pro").

Bitten by it: featureService's kind fallback (fixed 2026-09-05), an earlier `requiredTier` always-'pro' bug, and every conversation where someone said "pro" and meant Growth.
