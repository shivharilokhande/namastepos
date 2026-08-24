# Mobile setup — Google Sign-In + Razorpay (Push 9 / Push 10)

The Flutter code for both is fully wired. Before either feature works on a
real device or simulator, you need to do some platform-specific config
(OAuth clients on Google Cloud, URL schemes in `Info.plist`, Razorpay keys
in `.env`). This doc walks through it end-to-end.

If you'd rather just verify Push 9 / Push 10 code-side first, the Flutter
side compiles and the dev-login path keeps working — none of these steps
break the existing auth flow.

---

## Part 1 — Google Sign-In on iOS

The Flutter side is already wired in
`lib/services/auth_service.dart` and surfaced as a button on
`lib/screens/auth/login_screen.dart`. What's missing is the iOS OAuth
client + URL scheme registration so `GoogleSignIn.signIn()` can actually
open the account picker.

### 1.1 — Create OAuth client IDs in Google Cloud Console

If your project already has a **Web client ID** (used by the backend +
dashboard), skip step (a). You only need (b) and (c) for mobile.

1. Open https://console.cloud.google.com/apis/credentials → your project.
2. **(a) Web client ID** — required because the backend verifies tokens
   with audience = web client. Create one if it doesn't exist:
   - **+ Create credentials → OAuth client ID**
   - Application type: **Web application**
   - Name: `NamastePOS web client`
   - Authorized JavaScript origins: `http://localhost:5174`, `http://localhost:5173`, plus prod
   - Authorized redirect URIs: leave empty (we use idToken flow, not redirect)
   - Save → copy the `Client ID` (something like `123-abc.apps.googleusercontent.com`)
3. **(b) iOS client ID** — drives the native picker on iPhone:
   - **+ Create credentials → OAuth client ID**
   - Application type: **iOS**
   - Name: `NamastePOS iOS`
   - Bundle ID: same as `ios/Runner.xcodeproj/project.pbxproj → PRODUCT_BUNDLE_IDENTIFIER`. Default is `com.example.namastepos` — change it to something owned by you (e.g. `in.namastepos.app`) before going to production.
   - Save → note the `Client ID` AND the `iOS URL scheme` (reverse-DNS form of the client ID).
4. **(c) Android client ID** — only if you ship to Play Store. For dev
   on emulator, the Web client ID is enough.
   - Application type: **Android**
   - Package name: same as `android/app/build.gradle → applicationId`
   - SHA-1 certificate fingerprint:
     ```bash
     keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android -keypass android | grep SHA1
     ```
   - Save.

### 1.2 — Tell the Flutter app about the Web client ID

The backend verifies the `idToken`'s audience against `GOOGLE_CLIENT_IDS`,
so the iOS picker must request a token signed for the **Web** client. The
`google_sign_in` package handles this when you pass `serverClientId`; we
already read it from a dart-define:

```bash
flutter run -d "iPhone 15" \
  --dart-define=API_URL=http://localhost:4000/v1 \
  --dart-define=GOOGLE_WEB_CLIENT_ID=123-abc.apps.googleusercontent.com
```

Bake it into your IDE run config so you don't retype it every time. VS
Code: add `"toolArgs"` in `launch.json`. Android Studio: Edit
Configurations → "Additional run args".

### 1.3 — Register the iOS URL scheme

This is the single step everyone forgets. Without it the Google picker
opens and immediately closes with no error.

1. Open `ios/Runner/Info.plist` in a text editor (not Xcode, which
   rewrites the file).
2. Inside the top-level `<dict>` add:
   ```xml
   <key>CFBundleURLTypes</key>
   <array>
       <dict>
           <key>CFBundleTypeRole</key>
           <string>Editor</string>
           <key>CFBundleURLSchemes</key>
           <array>
               <!-- Paste the "iOS URL scheme" from Google Cloud here.
                    Format: com.googleusercontent.apps.123-abc -->
               <string>com.googleusercontent.apps.123-abc</string>
           </array>
       </dict>
   </array>
   ```

### 1.4 — Update the backend allow-list

The backend verifies the idToken audience against
`GOOGLE_CLIENT_IDS` (comma-separated) in `namastepos_backend/.env`. Add
the **Web** client ID (only the web one — iOS client tokens we don't
verify directly because google_sign_in re-signs them for the web client
via `serverClientId`):

```bash
GOOGLE_CLIENT_IDS=123-abc.apps.googleusercontent.com
```

Restart the backend.

### 1.5 — Smoke test

```bash
cd namastepos_flutter
flutter clean && flutter pub get
cd ios && pod install && cd ..
flutter run -d "iPhone 15" \
  --dart-define=API_URL=http://localhost:4000/v1 \
  --dart-define=GOOGLE_WEB_CLIENT_ID=<your-web-id>
```

On the login screen tap "Continue with Google". Expected: account picker
opens → pick account → backend logs `findOrCreateUser` → app lands on
the home screen with the same business you have on the web dashboard.

### Troubleshooting

| Symptom | Likely cause |
|---|---|
| Picker opens then immediately closes | URL scheme missing from `Info.plist` |
| "Network error" toast after picking account | Wrong `GOOGLE_WEB_CLIENT_ID` (mobile sending wrong audience) |
| Backend 401 with "Invalid token" | Web client ID not in backend `GOOGLE_CLIENT_IDS` |
| Works once, then fails every time | iOS deployment target too low (need ≥ 11). Open Xcode → Runner → General → Deployment Info |

---

## Part 2 — Razorpay native checkout

Push 9 swapped the TODO snackbar in `BillingScreen` for the real
`razorpay_flutter` SDK. The Flutter code calls
`POST /billing/change { tier }` → opens the native Razorpay modal
with the returned `subscription_id`. Webhooks update the DB; we
`refreshPlan()` on success to catch the UI up.

### 2.1 — Get Razorpay test keys

1. Sign in at https://dashboard.razorpay.com (use **Test mode**)
2. Settings → API Keys → **Generate Test Key**
3. Copy `Key ID` (starts with `rzp_test_…`) and `Key Secret`.

### 2.2 — Backend env

Add to `namastepos_backend/.env`:

```bash
RAZORPAY_KEY_ID=rzp_test_xxx
RAZORPAY_KEY_SECRET=yyy
RAZORPAY_WEBHOOK_SECRET=zzz   # set after step 2.4
```

Restart backend. Hit the admin sync endpoint **once** to push our plans
into Razorpay:

```bash
curl -X POST http://localhost:4000/v1/admin/razorpay/sync \
  -H "Authorization: Bearer $SUPER_ADMIN_JWT"
```

This populates `plans.razorpay_plan_id` for the Pro + Enterprise tiers.
Without it, `changePlan` 400s with "Razorpay plan not synced".

### 2.3 — pod install on iOS

```bash
cd namastepos_flutter/ios
pod install --repo-update
```

Razorpay's iOS pod needs a deployment target of ≥ 12. If you get a
Podfile error, open `ios/Podfile` and set:

```ruby
platform :ios, '12.0'
```

### 2.4 — Webhook for local dev

Razorpay needs a public URL to send `subscription.charged` etc. For
local development, use a tunnel:

```bash
# In a new terminal
ngrok http 4000
```

Copy the `https://….ngrok.io` URL. In Razorpay dashboard:
**Settings → Webhooks → + Add new webhook**
- URL: `https://<ngrok>.ngrok.io/v1/webhooks/razorpay`
- Active events: `subscription.activated`, `subscription.charged`, `subscription.cancelled`, `payment.failed`
- Secret: copy the value, paste it into `RAZORPAY_WEBHOOK_SECRET` in your backend `.env`, restart backend.

### 2.5 — Smoke test

```bash
flutter run -d "iPhone 15" --dart-define=API_URL=http://<your-mac-LAN-ip>:4000/v1
```

(Mobile must talk to the same backend that ngrok is forwarding to so the
webhook flow actually closes the loop.)

In the app: Drawer → Plans & billing → tap **Upgrade to Pro**. Expected:

1. Spinner on the Upgrade button (3-5s while we call `/billing/change`).
2. Native Razorpay modal slides up.
3. Pick **UPI** → use test VPA `success@razorpay`.
4. Modal closes → "Payment received. Activating pro plan…" snackbar.
5. ngrok logs show a `POST /v1/webhooks/razorpay` hit.
6. After a few seconds: "You're on the Pro plan now" → drawer's locked items unlock.

### Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Backend did not return a valid Razorpay subscription" | Razorpay plans not synced (run step 2.2 admin sync) |
| Modal opens but shows "Payment failed: BAD_REQUEST" | `subscription_id` invalid — check backend logs for the Razorpay 4xx |
| Modal closes, no toast, plan unchanged | Webhook not delivered. Check ngrok inspector at http://127.0.0.1:4040 |
| "Checkout cancelled" every time | You're tapping outside the modal; tap "Pay" |
| Android: "Razorpay SDK not initialized" | minSdkVersion < 19 in `android/app/build.gradle` — bump to 21 |

---

## Quick smoke-test commands

After both setups are done:

```bash
cd namastepos_flutter
flutter clean
flutter pub get
cd ios && pod install --repo-update && cd ..
flutter analyze

flutter run -d "iPhone 15" \
  --dart-define=API_URL=http://<lan-ip>:4000/v1 \
  --dart-define=GOOGLE_WEB_CLIENT_ID=<your-web-id>
```

If `flutter analyze` flags anything from Push 7 / 8 / 9 / 10, share the
output and we'll fix it.
