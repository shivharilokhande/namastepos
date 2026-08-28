# NamastePOS — Roadmap & Follow-ups (2026-08-28)

Consolidates the code-review follow-ups and the product brainstorm into one actionable list. Status as of commit `e0aef34`.

---

## Part A — Code-review follow-ups

### ✅ Done this pass (shipped in `e0aef34`)
- **Retention dry-run.** `retentionService.preview()` + `GET /admin/compliance/retention/preview` count exactly what a sweep would delete, without deleting. Admin Retention tab now has a **Preview** button, an eligible-count banner, and a **permanence confirm** dialog before Run.
- **Retention SQL hygiene.** Switched interval math to `make_interval(days => $1::int)`; documented in-code that operators must meet statutory record-retention (GST/financial) before enabling tenant purges.
- **Cookie-auth fallback flagged.** Added a clear TODO to remove the localStorage Bearer fallback in `admin/src/api/client.ts` once cookie-auth is verified in prod (it re-introduces XSS token exposure).
- **Tests for new security surface.** `adminSecurity2026.test.js` (10/10): CSRF `ff_admin` exemption + `ff_refresh` still enforced; 2FA-enforcement login mints an enrol-only token; retention safe defaults / preview / sweep no-op when disabled. Locks the fixes against regression.

### ⏳ Remaining (prioritized)
1. **[P1] Verify cookie-auth in prod, then remove the Bearer fallback.** Confirm `ff_admin` httpOnly cookie round-trips on the live admin (DevTools: cookie present, `ff_admin_token` absent from localStorage). Once confirmed, delete the fallback branch + the localStorage token path. *Owner: founder verify → I remove.*
2. **[P2] Separate "diner erasure" from "tenant purge" in retention.** Today a tenant purge also deletes its `audit_log`/financial trail. Consider retaining an anonymized financial summary (or an export hook) before hard-delete, so DPDP erasure and GST record-keeping don't conflict. *Design + build.*
3. **[P2] HTTP-level tests for the enrol-only 2FA gate.** Unit coverage exists for the login branch; add an integration test that an `enrol2fa` token gets 403 on a sample mutating admin route and 200 on `/auth/2fa/enrol` (needs a seeded active `admin_users` row for the live-active check).
4. **[P3] Blog maintainability.** 23 near-identical HTML files. Fold the head/nav/footer/schema boilerplate into a committed generator (extend the scratch `genblog.py`) so future posts can't drift. Optional — static HTML is fine at this size.
5. **[P3] Pagination at scale.** `COUNT(*) OVER ()` recomputes per page; fine now. Move Orders/Customers to keyset/seek pagination if volumes grow large.
6. **[P3] Accepted, no action.** Plan-limit TOCTOU (owner self-inflicted); MPIN PBKDF2 stretching (needs a dep, local-device-only risk).

---

## Part B — Product bets (from the brainstorm)

### The one thing to be famous for
**"The POS that never stops billing."** Offline-first is concrete, demoable, and hard for cloud-only incumbents to retrofit. Make it the headline everywhere.

### Now (next 90 days) — distribution over features
1. **Reseller / affiliate channel.** You have more product than customers; the bottleneck is GTM. Recruit local IT/accounting shops that already sell to restaurants (the reseller one-pager + referral system exist). *Highest leverage.*
2. **Activation instrumentation.** Track signup → first real bill → 7-day-retained (GA4 + CRM lifecycle stages already in place). Shorten onboarding ruthlessly; a free tier only compounds if tenants reach "first bill" fast.
3. **Prove the moat.** Publish "bills captured offline" / uptime stats, a 30-second outage demo video, and case-study numbers. Feeds the new SEO cluster.

### Next — monetization depth (higher margin than new logos)
4. **Grow add-on / revenue-share attach:** WhatsApp campaigns (once Meta setup done), e-invoicing at scale, advanced analytics — sold to existing tenants at near-zero CAC.
5. **Verify dunning / past-due end-to-end** with a real failed charge now that Razorpay is live.

### Later / watch
- Consent viewer in admin (needs a new backend read endpoint); tags/segments; pre-signup lead pipeline; support SLA/priority/assignment.
- **Risks:** solo-founder concentration (keep investing in tests/docs/memory), payments dependency (Razorpay is the revenue chokepoint), support load as the free tier grows.

### Founder-blocked (external accounts)
- Meta WhatsApp developer registration (personal FB profile) → then finish Cloud API setup.
- GBP "Get verified"; remaining directory submissions from the pack.
- Directory backlinks (SEO).

---

## The provocative question
If you could keep only **three** features and delete the rest, which three? If it isn't obvious, the product is broader than the story — and the story is what sells. Likely answer: **offline billing + GST + KOT/KDS**; everything else is expansion revenue on top of that core.
