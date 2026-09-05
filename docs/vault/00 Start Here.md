---
tags: [namastepos, moc]
updated: 2026-09-06
---
# NamastePOS — Start Here (Map of Content)

Obsidian-style vault: open `docs/vault/` as a vault, or read the files in order. Every note is short and links to the code it describes. **Read [[Tier Code Trap]] before touching plans.**

## Orientation
- [[Architecture]] — what runs where, how a request flows
- [[Feature Registry and Gating]] — the one list of feature keys and the four places that must agree
- [[Plans Billing and Subscriptions]] — statuses, Razorpay, resume/pause/downgrade rules (rewritten 2026-09-05)
- [[GST and Money]] — paise, slabs, who computes tax, composition scheme
- [[Tier Code Trap]] — `pro` is Enterprise

## Working on it
- [[Dev Loop and Gates]] — run tests, lint, audit; the `| tail` trap; CI's red ✗ that is not red
- [[Deploy and Verify]] — Render auto-deploy, `/v1/health`, migrations, APK to R2
- [[Founder Rules]] — standing instructions and UX rules that are not in the code

## History
- [[Code Review 2026-09-05]] — what was found, what was fixed, what is open
- `../review-2026-09-05/` — the raw reviewer and fixer reports with file:line evidence
- `../../HANDOVER.md`, `../../TRACKER.html` — session handover and the live checklist
