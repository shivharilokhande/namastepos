# Meta WhatsApp Cloud API — setup guide

NamastePOS now sends WhatsApp via **Meta's WhatsApp Cloud API directly** (no Twilio/MSG91 BSP markup). The code is live but **inert until you add the credentials + approved templates below**. When unconfigured it falls back to Twilio, then to a harmless mock-log.

## Is it free?
The **API itself is free**. Meta charges per *conversation* by category:
- **Service** (customer messages you within 24h): first **1,000/month free**, then per-conversation.
- **Utility** (order/receipt updates), **Authentication** (OTP), **Marketing**: priced per message in India (utility/auth are cheap; marketing costs more).

So it's dramatically cheaper than SMS/BSPs, but not literally ₹0 for business-initiated messages. Free-form replies inside the 24-hour window are free (within the service tier).

## One-time setup (≈30–45 min)
1. **Meta Business + WhatsApp:** at [business.facebook.com](https://business.facebook.com) create/confirm a Business, then in [developers.facebook.com](https://developers.facebook.com) create an app → add the **WhatsApp** product.
2. **Phone number:** add and verify a business phone number (not one already on the WhatsApp consumer app). Note its **Phone number ID**.
3. **Permanent token:** create a **System User** (Business Settings → Users) with `whatsapp_business_messaging` + `whatsapp_business_management`, generate a **permanent access token**.
4. **App secret:** Business/App Settings → Basic → **App Secret** (for webhook signature).
5. **Webhook:** WhatsApp → Configuration → Webhook →
   - Callback URL: `https://api.namastepos.in/v1/meta-wa-webhooks`
   - Verify token: any secret you choose (must equal `META_WA_VERIFY_TOKEN`)
   - Subscribe to fields: **messages**.
6. **Templates:** WhatsApp Manager → Message templates. Create + get approved:
   - **OTP** — category **Authentication**, one body variable `{{1}}` + a "Copy code" URL button. Put its name in `META_WA_OTP_TEMPLATE`.
   - (Later) **utility** templates for order/receipt updates, and **marketing** templates for campaigns.

## Environment variables (set on Render)
```
META_WA_PHONE_NUMBER_ID=<from step 2>
META_WA_ACCESS_TOKEN=<permanent token from step 3>
META_WA_APP_SECRET=<from step 4>
META_WA_VERIFY_TOKEN=<the secret you chose in step 5>
META_WA_OTP_TEMPLATE=<approved OTP template name>
META_WA_API_VERSION=v20.0   # optional
META_WA_LANG=en             # optional; template language code
```
Once `META_WA_PHONE_NUMBER_ID` + `META_WA_ACCESS_TOKEN` are set, the platform uses Meta for all WhatsApp sends. Once `META_WA_OTP_TEMPLATE` is set too, phone-login OTP goes over WhatsApp (SMS/MSG91 becomes the fallback).

## What's wired in code
- `whatsappService`: `_sendOutbound` prefers Meta; `sendTemplate({to, templateName, languageCode, components})` for business-initiated messages; `isMetaConfigured()`.
- `otpService`: OTP sends via WhatsApp auth template when configured, else MSG91 SMS, else dev-log.
- Webhook `GET/POST /v1/meta-wa-webhooks`: verification handshake, `X-Hub-Signature-256` verification, delivery-status logging, best-effort inbound routing to a business by the sender's customer record.
- Campaigns + one-off `sendRaw` already flow through `_sendOutbound`, so they use Meta automatically.

## Notes / limits
- **One shared WABA number** for the platform: inbound conversational ordering can only be attributed to a business when the sender's phone matches exactly one business's customer record; otherwise it's logged, not dropped.
- Business-initiated messages **must** use an approved template — free-form text only delivers inside the 24h service window.
