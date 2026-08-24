# FoodFlow — Regulatory Compliance Gap Analysis & Remediation Plan

**Status as of 2026-05-26:** 🔴 **Not yet ready to take paying customers in production.**
**Verdict:** The product features are largely in place (GST, invoicing, Razorpay), but the legal-policy-process scaffolding around the product is missing. This document is the gap analysis and the fix plan.

This is **not legal advice.** It's an engineer's reading of the regulations, written so a founder can move quickly. Run any production launch by a startup lawyer before going live — budget ~₹15-25k for an initial review.

---

## TL;DR — traffic-light overview

| Area | Status | Effort to fix |
|---|---|---|
| **GST tax compliance on invoices** | 🟢 Green — code paths exist | Verify accuracy with a CA, ~1 day |
| **e-Invoice (IRN) integration for ≥₹5Cr customers** | 🟡 Yellow — on Sprint 2 roadmap | 1 sprint |
| **DPDP Act 2023 (data protection)** | 🔴 **Red — multiple critical gaps** | ~2 weeks |
| **RBI data localization (payment data)** | 🟡 Yellow — depends on hosting choice | 2 days (hosting move) |
| **IT Rules 2021 (intermediary)** | 🟡 Yellow — grievance officer not named | 1 hour |
| **PCI-DSS (card data)** | 🟢 Green — Razorpay handles | None, just verify we never touch raw card numbers |
| **PA-PG license (payment aggregator)** | 🟢 Green — we use Razorpay, not our own PA | None |
| **Company-level legal** | 🟡 Yellow — needs founder confirmation | Varies |
| **FSSAI** | 🟢 Green — applies to restaurants, not us | None |
| **State excise (liquor)** | 🟢 Green — we display licensee's number, don't issue | None for now |

---

## 1. DPDP Act 2023 — The Big Red

The Digital Personal Data Protection Act 2023 came into full force in 2025. Penalties: up to **₹250 crore per breach.** Every byte of customer name, phone, address, order history is "Personal Data" under DPDP.

You are a **Data Fiduciary** for restaurant owner accounts. You are a **Data Processor** for restaurant customers' data (where the restaurant is the Data Fiduciary). Both roles have obligations.

### 1.1 Required disclosures in Privacy Policy

DPDP requires a published notice with 9 specific items. **None of these are currently written down anywhere on foodflow.in.**

1. Identity of the Data Fiduciary (you / FoodFlow Pvt Ltd)
2. Contact of the Grievance Officer
3. Categories of personal data being collected
4. Purpose of processing each category
5. Manner of withdrawing consent
6. Manner of exercising data principal rights
7. Manner of complaining to the Data Protection Board (DPB)
8. Cross-border data transfers (if any)
9. Retention period for each data category

**Fix:** Task #117 — draft + publish privacy policy at `foodflow.in/privacy`. Reviewed by lawyer. Linked from every signup flow.

### 1.2 Consent — explicit, granular, withdrawable

DPDP requires consent that is:
- **Free** — no service refusal for refusing consent (except for what's strictly needed to deliver the service)
- **Specific** — separate consents for separate purposes
- **Informed** — user knows what they're consenting to
- **Unconditional** — no pre-ticked boxes
- **Clear** — not buried in ToS
- **Withdrawable** — same ease as giving

**Current state:** No consent UI exists anywhere in FoodFlow. User signs up → backend stores name + phone + email with no explicit consent capture.

**Fix:** Task #119 — consent checkbox on every PII collection point. Separate toggles for marketing communications. Backend persists consent timestamp + policy version.

### 1.3 Audit log of consent

You must be able to prove "user X gave consent for purpose Y at time Z under policy version V" if the DPB asks. No audit log = no defense.

**Fix:** Task #122 — `consent_events` table + writes on every consent action.

### 1.4 Data principal rights (access, correction, erasure, portability)

Every user can demand:
- A copy of all their data (Right to Access)
- Correction of incorrect data (Right to Correction)
- Erasure of their data (Right to Erasure)
- Portability of their data in machine-readable format (Right to Portability)

You must respond within "a reasonable time" (interpreted as 30 days).

**Current state:** No endpoints exist for any of these.

**Fix:** Task #121 — three endpoints under `/v1/me/`:
- `GET /export` → JSON download of all PII
- `DELETE /account` → soft-delete with 30-day cooldown + audit
- `PATCH /correct` → update stored data + audit

UI in mobile Profile screen + dashboard Settings.

### 1.5 Data breach notification — 72 hours

Within 72 hours of becoming aware of a personal-data breach, you must notify:
- The Data Protection Board (DPB), and
- Every affected Data Principal

**Current state:** No detection process, no notification template, no contact list ready.

**Fix:** Task #126 — runbook with detection signals, triage checklist, notification templates, forensic preservation, post-mortem.

### 1.6 Grievance Officer

DPDP + IT Rules 2021 both require a named Grievance Officer with published contact. Response SLA under IT Rules: 24h acknowledgment, 15-day resolution.

For a solo-founder stage, this is **you.** No new hire required. But the role must be named and the contact published.

**Fix:** Task #120 — designate yourself as GO, publish `grievance@foodflow.in` (or similar) in:
- Mobile app drawer (Help → Grievance Officer)
- Dashboard help menu
- `foodflow.in` footer
- Privacy policy

### 1.7 Cross-border transfer

If any Indian customer data leaves India, that has to be disclosed in your privacy notice and (eventually) the DPB will publish a "negative list" of countries — transfers to those will be banned.

**Current state:** DEPLOYMENT.md currently recommends Render Singapore — which means **your customer data leaves India today.** This is an immediate fix.

**Fix:** Task #123 — move hosting to India region:
- **Oracle Cloud Always Free** (Mumbai/Hyderabad) — ₹0 forever, 4-core ARM, 24 GB RAM
- **DigitalOcean Bangalore** — $4-6/mo, easier setup
- **AWS Mumbai t4g.nano** — free 12 months

Until moved, your privacy policy must disclose the Singapore transfer.

### 1.8 Significant Data Fiduciary threshold

You're not one yet. You'd become one if processed personal data crosses a notified threshold (DPB will publish) or based on risk classification. At Phase 1 beta (<100 restaurants, ~5k customers each = 500k people) you're not there. Worth re-checking annually.

---

## 2. GST + Tax — Where the product is strongest

### 2.1 What's working ✅

The codebase already has:
- CGST/SGST/IGST split logic on tax invoices
- HSN/SAC code field on menu items
- B2B vs B2C invoice distinction
- Place-of-supply logic (CGST+SGST for intra-state, IGST for inter-state)
- Tax invoice CRUD + PDF export

**Verify with a CA before launch:**
- Are the rate slabs correct for restaurant categories (5% non-AC, 5% AC restaurant under composition, 18% with liquor, 18% standalone delivery)?
- Is the GSTIN-based reverse-charge logic correct for B2B billing >₹5,000?
- Are the invoice fields complete per Rule 46 of CGST Rules?

### 2.2 What's missing 🟡

#### e-Invoice (IRN + QR) mandate

For any business with annual turnover **≥ ₹5 crore** (lowered from ₹10Cr in Aug 2023), every B2B invoice must:
- Be uploaded to the **Invoice Registration Portal (IRP)**
- Get an **IRN (Invoice Reference Number)** back
- Display the IRN-encoded QR code on the printed invoice

**Current state:** Not implemented. ROADMAP.md has it scheduled for Sprint 2.

**Impact:** Most Phase 1 beta customers (small cafés < ₹5Cr turnover) don't need this. But any cloud kitchen or chain you onboard later will. **Block on Phase 2 launch, not Phase 1.**

**Fix path:** Integrate with one of the IRP API providers — ClearTax, Cygnet, GSP-licensed gateways. ~1 sprint.

#### GSTR-1 export

Every month, your restaurant customers have to file GSTR-1. They'll expect your software to export the data in GSTR-1 JSON format.

**Current state:** PDF/CSV export exists, GSTR-1 JSON format does not.

**Fix:** Sprint 2 of ROADMAP — add GSTR-1 export button on the GST page.

---

## 3. RBI + Payment Compliance

### 3.1 PCI-DSS — what we DON'T do is what matters

PCI-DSS applies to anyone who handles cardholder data. **We never see card numbers** because Razorpay's checkout opens in Razorpay's iframe / redirect — the card number goes straight from customer to Razorpay.

**As long as the codebase never:**
- Accepts a card number in any form field
- Stores a card number in any DB column
- Logs a card number to any file
- Sends a card number over the network

…we are out of scope. **Verify with a grep:** no `card_number`, no `cvv`, no `pan` (in the card-data sense, not Permanent Account Number) anywhere in the schema or code. If clean → PCI-DSS not applicable → Razorpay's compliance covers us.

### 3.2 RBI Tokenization Mandate (Card-on-File)

Since Oct 2022, merchants cannot store CoF (card-on-file) data — only tokens. Razorpay handles this. We just store the Razorpay `payment_id` and `subscription_id`. **We're fine.**

### 3.3 Payment Aggregator (PA) license

Required if we route money between buyers and merchants ourselves. **We don't.** We use Razorpay (a licensed PA), and Razorpay settles directly to the restaurant's bank account. **We're not in scope.**

### 3.4 Data localization for payment data

RBI's April 2018 directive: end-to-end payment transaction data must be stored only in India. There's some debate about whether SaaS records of payments fall under this (vs the PA's records). Conservative interpretation: yes. **Hosting in India removes the ambiguity.**

---

## 4. IT Act 2000 + IT Rules 2021

### 4.1 Intermediary obligations

FoodFlow is an "intermediary" (we store and transmit user-generated content). Obligations:

| Item | Required? | Status |
|---|---|---|
| Grievance Officer named | ✅ Required | ❌ Not done — Task #120 |
| Compliance Officer | Only if "Significant Social Media Intermediary" (5M+ users) | N/A |
| Monthly transparency report | Only if SSMI | N/A |
| 24h acknowledgment of complaints | ✅ Required | ⬜ Process not documented |
| 15-day resolution | ✅ Required | ⬜ Process not documented |
| Inform users of rules + privacy policy at signup | ✅ Required | ❌ Not done — Task #119 |
| Take down unlawful content within 36h of court order | ✅ Required | ⬜ Process not documented |

### 4.2 Reasonable security practices (Section 43A + SPDI Rules)

Although DPDP largely supersedes the old SPDI Rules, the IT Act Section 43A still applies for liability on data breaches. Reasonable security practices include:
- Documented information security policy ❌
- ISO 27001 *or* equivalent certified standard *or* a documented "comprehensive" security program 🟡 (informal)
- Encryption in transit (HTTPS) ✅
- Encryption at rest 🟡 (depends on hosting choice)
- Access controls + audit logs 🟡 (RBAC exists, audit logs partial)
- Incident response process ❌ — Task #126

**Pragmatic minimum for Phase 1 beta:** a 2-page security policy in the repo, HTTPS enforced, daily backups (✅ done), access logged, breach runbook ready. Add ISO 27001 only when an enterprise customer demands it (probably Year 2).

---

## 5. Company-level legal

These aren't code problems — they're founder-checklist problems. Until done, you can't take production money.

### 5.1 Incorporation

| Structure | Pros | Cons | Cost |
|---|---|---|---|
| Sole Proprietorship | Cheapest, fastest | Personal liability, no investors | ₹0 |
| LLP | Limited liability, simpler than Pvt Ltd | No equity for investors, ROC filings | ~₹6-10k |
| **Private Limited** | Equity, investors, professional | Annual ROC + audit costs ~₹20-30k/yr | ~₹15-20k incorporation |

**Recommendation:** Pvt Ltd if you ever plan to take outside money. LLP if "just me, no investors". Sole prop is fine for an MVP test but should be upgraded before public launch.

**Fix:** Task #124 — confirm with founder.

### 5.2 GSTIN for FoodFlow itself

Required to issue tax invoices to your customers (the restaurants). Mandatory if:
- Aggregate turnover > ₹20L/yr (services), or
- You make inter-state supplies (likely yes — Bangalore restaurant, Pune SaaS)

Time to obtain: 7-15 days. **Apply now, even if no revenue yet.**

### 5.3 Trademark

"FoodFlow" — search at [ipindia.gov.in](https://ipindiaonline.gov.in/) for prior registrations in Class 9 (software) and Class 42 (SaaS services). File if clear. ~₹4,500 per class, takes 12-18 months to register.

**Not blocking launch, but file ASAP** — squatters watch new product launches.

### 5.4 Required B2B contracts

Customer-facing:
- **SaaS Subscription Agreement** — your boilerplate terms
- **DPA (Data Processing Agreement)** — DPDP requires this where restaurant is Data Fiduciary
- **Order Form** — for each customer / each plan tier

Vendor-facing:
- DPA with Razorpay, Twilio, Sentry, hosting provider — they all publish standard ones, sign electronically

**Fix:** Task #118 — get a startup lawyer to template these. ~₹15-25k one-time, reusable forever.

---

## 6. Phase-1 launch readiness — what's the minimum?

You don't need everything above to take your first 5 beta customers. Here's the **minimum viable compliance** for a closed-beta of friendly customers:

### Must have before customer #1 ⚠️

- [ ] Privacy policy published (even a basic one) — Task #117
- [ ] Consent checkbox on signup — Task #119
- [ ] Grievance Officer designated + contact published — Task #120
- [ ] India-region hosting OR disclosed cross-border transfer — Task #123
- [ ] Data deletion endpoint (manual is OK at this scale) — Task #121
- [ ] Backups working (✅ done)
- [ ] Backup verify working (✅ done)
- [ ] Signed agreement template (even handshake-equivalent email) — Task #118

### Defer to Phase 2 (post-beta, before public launch) 📅

- e-Invoice IRN integration (only if customer turnover crosses ₹5Cr)
- GSTR-1 JSON export
- Cookie consent banner (Phase 1 has minimal web traffic) — Task #125
- ISO 27001 certification (only on enterprise demand)
- Consent audit log (informal logging OK at Phase 1, formalize for Phase 2) — Task #122
- Breach response runbook formalization — Task #126
- Trademark filing
- DPA review by lawyer

### Defer to Year 2 📅

- Significant Data Fiduciary obligations (only at ~5M users)
- ISO 27001 cert
- SOC 2 Type II
- Independent security audit
- Bug bounty program

---

## 7. Cost of compliance — solo founder budget

| Item | One-time | Recurring | Phase |
|---|---|---|---|
| Lawyer fees (Privacy, ToS, DPA templates) | ₹15-25k | — | 1 |
| Incorporation (Pvt Ltd) | ₹15-20k | ₹25-30k/yr (ROC + audit) | 1 |
| GSTIN registration | ₹0 (self-file) | ₹0 | 1 |
| CA review of GST logic | ₹5-10k | ₹2-5k/yr | 1 |
| Trademark filing (2 classes) | ₹9k | — | 2 |
| Cookie consent (Klaro free / CookieYes free) | ₹0 | ₹0–600/mo | 2 |
| e-Invoice IRP provider (ClearTax / Cygnet) | ₹0 | ₹0.50-2/invoice | 2 |
| ISO 27001 certification | ₹3-5L | ₹1-2L/yr | 3 |
| Cyber insurance | — | ₹15-30k/yr | 2-3 |
| **Phase 1 total** | **~₹35-55k one-time + ₹25-30k/yr** | | |

---

## 8. The verdict for "tell me when I can launch"

You're **2 weeks of focused work + 1-2 weeks of lawyer turnaround** away from being able to onboard a friendly first customer with a clean conscience.

**Day-by-day plan:**

| Week | Days | Work |
|---|---|---|
| 1 | Mon-Tue | Incorporation paperwork + GSTIN application (Task #124) |
| 1 | Wed | Lawyer brief → drafting starts (Tasks #117, #118) |
| 1 | Thu | India-region hosting provisioned (Task #123) |
| 1 | Fri | Grievance Officer page + consent UI scaffolding (Tasks #119, #120) |
| 2 | Mon-Tue | Data subject rights endpoints + UI (Task #121) |
| 2 | Wed | Consent audit log (Task #122) |
| 2 | Thu | Lawyer review iteration |
| 2 | Fri | Pre-launch smoke test of full compliance stack |
| 3 | Mon | Lawyer signs off; Privacy + ToS published |
| 3 | Tue | First customer onboards |

**Compliance is not done in parallel with deployment — it gates deployment.** DEPLOYMENT.md now references this doc and waits for these tasks to finish before Phase A begins.

---

## 9. References

- DPDP Act 2023 — [official text](https://www.meity.gov.in/data-protection-framework)
- IT Act 2000 + IT Rules 2021 — [meity.gov.in](https://www.meity.gov.in/)
- e-Invoice GSTN portal — [einvoice1.gst.gov.in](https://einvoice1.gst.gov.in/)
- RBI 2018 data localization directive — [rbi.org.in](https://www.rbi.org.in/Scripts/NotificationUser.aspx?Id=11244)
- RBI Tokenization mandate — [rbi.org.in tokenization FAQ](https://www.rbi.org.in/Scripts/FAQView.aspx?Id=143)
- IndiaCode (one-stop law search) — [indiacode.nic.in](https://www.indiacode.nic.in/)

---

**Owner:** Shivhari Lokhande
**Last updated:** 2026-05-26
**Next review:** Before Phase 1 customer #1 onboards

---

## Appendix A — Implementation status (updated 2026-05-26)

The code-side compliance scaffolding landed in this push. Track the
**lawyer / paperwork** items separately in the task list.

### What's now in the codebase

- **Migration `041_dpdp_compliance.sql`** — adds tables:
  - `consent_events` (append-only) — every grant/withdrawal of every consent key
  - `data_subject_requests` + `data_subject_request_events` — access / correction / erasure / portability with SLA timer
  - `grievance_complaints` — DPDP s.13 grievance log with 48h ack + 30d resolve SLAs
  - `breach_incidents` — DPDP s.8(6) breach register with notification timestamps
  - `compliance_settings` — singleton row for grievance officer, DPO, legal entity, current policy versions
- **`services/complianceService.js`** — single point of entry for all four pillars
- **Routes** —
  - `/v1/me/consents` (GET / POST) and `/v1/me/consents/history`
  - `/v1/me/dsr` (GET / POST), `/v1/me/correct` (POST)
  - `/v1/me/export` (GET — JSON with SHA-256 attestation)
  - `/v1/me/account` (DELETE — soft-erase: anonymise identifiers, keep legally-required records)
  - `/v1/compliance/grievance-officer` (GET, public)
  - `/v1/compliance/grievance` (POST, public)
  - `/v1/compliance/consent` (POST, public — cookie banner)
  - `/v1/compliance/guest-consent` (POST, public — guest QR diner)
  - Admin paths under `/v1/admin/compliance/*` (settings, DSRs, grievances, breaches)
- **Mobile (Flutter)** — `RegisterScreen` now records granular consent (policy + ToS mandatory, marketing email/WhatsApp optional, all default-off). `ApiService` gains `recordConsent`, `currentConsents`, `fileDataSubjectRequest`, `exportMyData`, `eraseMyAccount`, `grievanceOfficer`, `fileGrievance`.
- **Dashboard (React)** — `RegisterPage` mirrors the mobile flow with the same four checkboxes and post-registration consent recording. New `/privacy` page lets owners toggle consents, download their data, file corrections, file grievances, and delete their account. `/legal/privacy` and `/legal/terms` render a clearly-marked DRAFT scaffold (pending lawyer review). Cookie banner appears on every page until dismissed.
- **Backend integration test** — `tests/integration/compliance.test.js` covers the happy paths.

### What still needs human action

| # | Task | Owner | Blocker for | Action |
|---|---|---|---|---|
| #117 | DPDP-compliant Privacy Policy (legal text) | Lawyer | First paying customer | Brief lawyer; replace draft text in `LegalPage` |
| #118 | Terms of Service + Customer SaaS Agreement | Lawyer | First paying customer | Same as #117 |
| #120 | Designate Grievance Officer | Founder | DPDP s.13 compliance | PUT name/email/phone/address via `PUT /v1/admin/compliance/settings` |
| #123 | India-region hosting decision + provision | Founder | RBI / DPDP localization | Oracle Cloud Mumbai (free) or DigitalOcean Bangalore (~₹500/mo) — see DEPLOYMENT.md |
| #124 | Incorporation, GSTIN, bank account | Founder | Razorpay onboarding | CA workflow — ~₹15-20k + 2-3 weeks |
| #126 | Data breach response runbook (DPDP 72h SLA) | Founder + lawyer | Pre-launch checklist | Document phone-tree + DPB contact + template emails |

### Pre-launch verification

Once the human-action items above land, run:
1. `npm run migrate` — apply migration 041
2. `npm test -- compliance.test.js` — happy paths pass
3. Manually: register a new account, withdraw a consent in `/privacy`, file a DSR, export, then delete. Confirm `consent_events` has the row history.
4. PUT real Grievance Officer details via the admin API and verify `/v1/compliance/grievance-officer` returns them.
