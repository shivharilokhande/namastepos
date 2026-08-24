# FoodFlow — WhatsApp Business API vetting checklist (FF-305)

**Start this today.** Twilio's WhatsApp sandbox works for testing, but sending to any real customer number requires Meta Business Verification. That process takes 2-3 weeks minimum, sometimes longer, and Meta rejects the first submission ~30% of the time on paperwork problems. If you want auto-WhatsApp on order-ready to work at launch, kick this off now.

---

## Step 1 — Meta Business Manager account (Day 0)

1. Go to https://business.facebook.com/
2. Log in with the Facebook account you'll use for the business (create a dedicated personal FB if you don't want it tied to yours — Meta allows this)
3. Create a new Business — name it "FoodFlow" or your registered entity name (must match your CIN/GST later)
4. Add the following assets under Business Settings:
   - **Business Info:** legal name, address (same as your CIN registration), website (`https://foodflow.in`), phone
   - **Payment methods:** add a credit card so ad accounts / verification fees can charge (some verification steps require a live card)

## Step 2 — Business Verification (Day 1-14)

Meta Business Manager → Business Settings → Security Center → Start Verification. You'll upload:

- **Certificate of Incorporation** (Registrar of Companies certificate)
- **PAN card** of the entity (not personal PAN)
- **GST certificate** (if you're GST-registered — highly recommended even if under ₹20L threshold, boosts trust score)
- **Utility bill** at the registered address, ≤3 months old
- **Bank statement** with the entity name, ≤3 months old
- **Authorization letter** if the person submitting isn't a listed director

**Common rejection reasons + how to avoid:**
- Uploading personal PAN instead of company PAN → REJECTED
- Business name on Meta doesn't match CIN exactly (spacing, capitalization) → REJECTED
- Utility bill is > 3 months old → REJECTED
- Website (`foodflow.in`) doesn't have Contact + Privacy Policy pages → REJECTED

Meta typically responds in 3-5 business days but can take up to 2 weeks. Check the Security Center for status; they'll email you.

## Step 3 — Register WhatsApp Business Account (Day 14-21)

Once Business Verification is approved:

1. Business Settings → WhatsApp Accounts → Add
2. Add your business phone number — it must NOT be already on WhatsApp personal. If it is, delete the WA account on that phone first.
3. Verify via SMS or voice code
4. Set the display name (customers will see this): "FoodFlow" or "FoodFlow India" (must not be misleading — no "Official FoodFlow" or "Cafe Sugar & Spice via FoodFlow")
5. Choose the messaging tier — start at Tier 1 (250 unique users/24h). Meta auto-upgrades based on delivery quality.

## Step 4 — Message Templates (parallel with Step 3)

Every proactive message (order-ready notification, daily digest, etc.) requires a pre-approved template. Draft these in Business Manager → WhatsApp Manager → Message Templates:

**Templates FoodFlow needs at launch:**

1. **`order_ready`** (Category: UTILITY, Language: en_IN + hi)
   Body: `Your order #{{1}} from {{2}} is ready. Please collect at the counter.`
   Variables: order number, business name

2. **`order_placed_confirmation`** (Category: UTILITY, en_IN + hi)
   Body: `Thanks for your order #{{1}} at {{2}}. Total: ₹{{3}}. We'll notify when it's ready.`

3. **`bill_link`** (Category: UTILITY, en_IN)
   Body: `Bill for your visit today at {{1}}: ₹{{2}}. Tax invoice: {{3}}`
   With button: URL button linking to the tax-invoice PDF

4. **`daily_owner_digest`** (Category: MARKETING, en_IN)
   Body: `Hi {{1}}, yesterday at {{2}} you did ₹{{3}} across {{4}} orders. Full report: {{5}}`
   With button: URL to dashboard

5. **`plan_expiry_warning`** (Category: UTILITY, en_IN)
   Body: `Your FoodFlow trial ends on {{1}}. Upgrade to keep KDS + WhatsApp notifications: {{2}}`

Template approval is per-template. UTILITY templates approve in ~1-2 days. MARKETING templates get more scrutiny (~3-5 days) and can be rejected for wording — keep them factual, not promotional. "Grow your restaurant with FoodFlow!" gets rejected; "Your daily FoodFlow report" gets approved.

## Step 5 — Connect to Twilio (Day 21+)

Once WA Business Account is approved AND at least one template is approved:

1. In Twilio Console → Messaging → Senders → WhatsApp → Register a WhatsApp Sender
2. Point Twilio at your Meta WABA (WhatsApp Business Account ID from Meta Business Manager)
3. Twilio handles the Meta API tokens for you
4. Test send using the approved template through Twilio's console
5. Update FoodFlow prod `.env`:
   ```
   TWILIO_ACCOUNT_SID=ACxxx
   TWILIO_AUTH_TOKEN=xxx
   TWILIO_WA_FROM=whatsapp:+91xxxxxxxxxx    # the approved sender
   ```
6. Redeploy backend — auto-WhatsApp on order-ready starts working

## Step 6 — Ongoing hygiene

- **Quality Rating** — Meta rates your WA number Green/Yellow/Red based on user reports + block rate. Yellow = customers are marking your messages as spam. Red = messaging paused. Rules of thumb:
  - Never send MARKETING category to users who haven't opted in (get explicit consent at signup — FoodFlow already captures this via DPDP consent flow)
  - Keep MARKETING template usage under 20% of total sends
  - Include an unsubscribe path in every marketing message ("Reply STOP to opt out")
- **Messaging tier** starts at 250 unique users / 24h. Ships quickly to 1K → 10K → 100K if quality stays Green. FoodFlow won't hit 1K unique users until you have ~50 cafes.

---

## Timeline summary

| Week | Milestone |
|---|---|
| Week 1 | Meta Business Manager set up, verification docs uploaded |
| Week 2 | Business Verification approved (or resubmit if rejected) |
| Week 3 | WABA registered, first 3 UTILITY templates approved |
| Week 3-4 | Twilio sender registered, tested, prod .env updated |

**Bottom line:** if you launch tomorrow with `TWILIO_*` env vars empty, the app silently skips auto-WhatsApp. Customers still order fine — they just don't get "order ready" pings until you finish the vetting. That's a smooth degradation, not a launch blocker.
