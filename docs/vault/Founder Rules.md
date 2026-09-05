---
tags: [namastepos, rules]
---
# Founder Rules (standing instructions)

- **Keep the MacBook awake** during any long run: `nohup caffeinate -dimsu &`. Every session, every prompt.
- **Show progress continuously** — task list in_progress/completed, say what is happening and what is pending. He is watching cost.
- **He does all logins, payments, OTP/2FA, CAPTCHAs.** Never type credentials.
- Concise, direct. Outcomes, not steps. Verify against live code / live API / a gate run before saying "done".
- No DB drops. No hardcoding (secrets, plan data, feature lists). Android-first. Indian-POS UX.
- Never name competitors (Petpooja etc.) on landing/blog/meta — "legacy POS" framing.
- Production never activates paid plans free. Money to paise. Staff cap excludes the owner.
- Flutter: never gate UI on `canPop`; no `ListView` inside `AlertDialog`; **no WhatsApp action on dine-in orders**; loyalty gating rules per plan key.
- Joi update schemas forked from create schemas need `.prefs({ noDefaults: true })` or partial updates reset fields.
- Security patterns: refresh-token user binding, super-admin read-only on business API, persistent PIN lockout, tenant-scope every id lookup, platform staff denied tenant API by default.
