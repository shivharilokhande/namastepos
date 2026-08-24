# NamastePOS — Flutter Mobile POS (PetPooja Clone)

A complete **micro-food POS** built in Flutter for **Android & iOS**.
Aimed at street vendors, dhabas, tea stalls, cloud kitchens, and small
restaurants — owners take orders, print tokens to a Bluetooth thermal
printer, manage menu/inventory/expenses, and watch a live P&L. **Works
offline-first** with local SQLite, syncs to the backend when online.

Built by **Smart IT by Shiv** — autonomous IT company pipeline (Founder
Arjun Mehta → CTO Vikram Rao → 13 specialist engineers).

---

## 📦 What's inside

```
namastepos_flutter/
├── pubspec.yaml                       # Dart deps (Provider, Dio, sqflite, esc_pos_*…)
├── analysis_options.yaml
├── lib/
│   ├── main.dart                      # Entry point
│   ├── app.dart                       # Root MaterialApp + auth gate
│   ├── constants/
│   │   ├── colors.dart                # Brand palette (orange #FF6B35)
│   │   ├── strings.dart
│   │   └── theme.dart                 # Material 3 theme (Inter typography)
│   ├── models/                        # 7 domain models
│   │   ├── business.dart
│   │   ├── menu_item.dart
│   │   ├── order.dart                 # Order + OrderItem
│   │   ├── cart_item.dart
│   │   ├── expense.dart
│   │   ├── inventory_transaction.dart
│   │   └── report.dart
│   ├── services/                      # I/O & domain services
│   │   ├── api_service.dart           # Dio + JWT refresh interceptor
│   │   ├── auth_service.dart          # OTP login (Twilio Verify) + demo mode
│   │   ├── database_service.dart      # SQLite, 11 tables, offline-first
│   │   ├── repositories.dart          # MenuRepo / OrderRepo / ExpenseRepo / InventoryRepo
│   │   ├── printer_service.dart       # Bluetooth ESC/POS thermal printer
│   │   ├── whatsapp_service.dart      # wa.me deep-link prefilled messages
│   │   └── notification_service.dart  # Local push (low-stock / order-ready)
│   ├── providers/                     # State (Provider / ChangeNotifier)
│   │   ├── auth_provider.dart
│   │   ├── menu_provider.dart
│   │   ├── orders_provider.dart       # Active cart + today's orders + KPIs
│   │   ├── inventory_provider.dart
│   │   ├── expenses_provider.dart
│   │   └── settings_provider.dart     # Printer/Aggregator/Notifications prefs
│   ├── screens/                       # 18 screens
│   │   ├── splash_screen.dart
│   │   ├── auth/  (login, otp, onboarding)
│   │   ├── home/  (home shell + dashboard)
│   │   ├── pos/   (new_order + confirm_order)
│   │   ├── orders/(orders + order_detail)
│   │   ├── inventory/(inventory + item_detail)
│   │   ├── menu/   (menu list + add/edit)
│   │   ├── expenses/(list + add)
│   │   ├── reports/ (daily charts + monthly)
│   │   └── settings/(menu, printer, aggregators, business info)
│   ├── widgets/                       # Reusable UI
│   │   ├── primary_button.dart
│   │   ├── kpi_card.dart
│   │   └── section_header.dart
│   └── utils/  (validators, formatters)
├── test/widget_test.dart
├── android/                           # Android wrapper (manifest, gradle, kotlin)
└── ios/                               # iOS wrapper (Info.plist, Podfile, AppDelegate.swift)
```

---

## ✨ Features (MVP v1, all 12 specified)

| # | Feature | Where it lives |
|---|---------|----------------|
| 1 | **Phone + OTP login** (Twilio Verify, demo OTP `123456`) | `screens/auth/*` |
| 2 | **Multi-tenant business model** (one account per stall) | `models/business.dart` |
| 3 | **Menu CRUD** with categories, veg flag, SKU, units | `screens/menu/*` |
| 4 | **POS order entry** (grid + cart, low-stock badges, search) | `screens/pos/new_order_screen.dart` |
| 5 | **Order confirmation** (dine-in / takeaway / Zomato / Swiggy, table no., UPI/Cash/Card) | `screens/pos/confirm_order_screen.dart` |
| 6 | **ESC/POS thermal printer** (58 mm & 80 mm) with branded receipt | `services/printer_service.dart` |
| 7 | **WhatsApp notifications** on order ready | `services/whatsapp_service.dart` |
| 8 | **Live order queue** with status (Pending → Ready → Collected/Cancelled), reprint, cancel-with-reason | `screens/orders/*` |
| 9 | **Inventory tracking** with movement log, low-stock alerts | `screens/inventory/*` |
| 10 | **Expense logging** with 9 categories | `screens/expenses/*` |
| 11 | **Daily / Monthly P&L dashboard** (pie + bar + line charts, top-items) | `screens/reports/*` |
| 12 | **Offline-first** (SQLite cache + `sync_queue` table for pending pushes) | `services/database_service.dart` |

Bonus: **Local notifications**, **secure JWT storage**, **theme system**,
**animations**, and **pull-to-refresh** everywhere.

---

## 🏃 Quick start

### Prerequisites
- Flutter SDK 3.10+ ([install](https://docs.flutter.dev/get-started/install))
- Android Studio (with Android SDK 23+)
- Xcode 14+ (only if building for iOS)
- Physical Bluetooth thermal printer (optional, for live printing)

### 1. Install
```bash
cd namastepos_flutter
flutter pub get
```

### 2. Run on Android (debug)
```bash
flutter run -d <android-device-or-emulator>
# OR for release APK:
flutter build apk --release
# OR for Play Store:
flutter build appbundle --release
```

### 3. Run on iOS (macOS only)
```bash
cd ios && pod install && cd ..
flutter run -d <ios-device>
# OR for App Store:
flutter build ipa --release
```

### 4. Backend URL
Override the API endpoint at build time:
```bash
flutter run --dart-define=API_URL=https://api.namastepos.in/v1
```

If the backend is unreachable, the app silently falls back to **demo
mode** — any 10-digit phone + OTP `123456` signs you in with a sample
menu pre-seeded.

---

## 🔐 Permissions

Already declared in `android/.../AndroidManifest.xml` and `ios/Runner/Info.plist`:

- **Bluetooth** (scan/connect) — thermal printer
- **Location** — required for BLE scanning on Android < 12
- **Notifications** — order updates, low-stock alerts
- **Camera + Photos** — receipt attachments (future)
- **Internet** — backend sync

---

## 🧪 Test

```bash
flutter test                  # widget + unit tests
flutter analyze               # lint
```

---

## 🎨 Design system

Built on **Material 3**, custom palette:

| Token | Value |
|---|---|
| Primary | `#FF6B35` (NamastePOS Orange) |
| Secondary | `#2EC4B6` (Teal) |
| Accent | `#FFB627` (Saffron) |
| Background | `#F7F8FA` |
| Success / Warning / Error / Info | semantic colors |

Typography: Google Fonts **Inter**. All input fields, buttons, chips,
nav bars, and cards use 12–16 px radii for a modern look. Charts
courtesy of `fl_chart`.

---

## 📡 Architecture

```
       ┌───────────────────────────────────┐
UI ──► │ Screens (60+ widgets)             │
       └────────────┬──────────────────────┘
                    │ context.watch / read
                    ▼
       ┌───────────────────────────────────┐
       │ Providers (ChangeNotifier)        │  ← state
       └────────────┬──────────────────────┘
                    │
                    ▼
       ┌──────────────┬────────────────────┐
       │ Repositories │ Services           │
       │ (SQLite)     │ (API/Printer/WA)   │
       └──────────────┴────────────────────┘
                    │
                    ▼
       ┌───────────────────────────────────┐
       │ Local SQLite (offline-first)      │
       │   ⇆ Backend REST API (via Dio)    │
       └───────────────────────────────────┘
```

**Offline-first**: every write hits SQLite immediately and is queued
in the `sync_queue` table; a periodic worker pushes pending deltas to
the backend when connectivity returns.

**Stock deduction is atomic**: order creation + inventory transaction
+ menu_items.stock update happen in a single `sqflite` transaction so
a crash mid-order won't leave stock inconsistent.

---

## 🔌 Backend contract

This Flutter app expects a REST backend matching the
`NAMASTEPOS_ARCHITECTURE.md` spec:

```
POST /auth/request-otp           → { verificationSid }
POST /auth/verify-otp            → { token, refreshToken, business }
POST /auth/refresh               → { token }
GET  /auth/me                    → Business

GET    /businesses/:id/menu
POST   /businesses/:id/menu
PUT    /businesses/:id/menu/:itemId
DELETE /businesses/:id/menu/:itemId

POST /businesses/:id/orders                  → Order
GET  /businesses/:id/orders?date=&status=    → [Order]
PUT  /businesses/:id/orders/:orderId/status  → { status }

POST /businesses/:id/expenses
GET  /businesses/:id/expenses?startDate=&endDate=

GET /businesses/:id/reports/daily?date=YYYY-MM-DD
GET /businesses/:id/reports/monthly?month=YYYY-MM
```

A reference Node.js implementation is described in
`../NAMASTEPOS_CLAUDE_CODE_BUILD.md` (Prompts 1.1–1.8).

---

## 🖨 Supported printers

Tested-class hardware (any 58/80 mm Bluetooth ESC/POS printer should
work):

- TVS RP 3160 Star / 3160 Gold
- Epson TM-P20, TM-T20 III
- Posiflex Aura PP-7000
- Bixolon SPP-R200III
- Generic Chinese thermal printers (most Esc/Pos compatible)

---

## 🚢 Build for stores

### Android (Play Store)
```bash
flutter build appbundle --release \
  --dart-define=API_URL=https://api.namastepos.in/v1
# Output: build/app/outputs/bundle/release/app-release.aab
```
Sign with your upload key (configure in `android/app/build.gradle`).

### iOS (App Store)
```bash
flutter build ipa --release \
  --dart-define=API_URL=https://api.namastepos.in/v1
# Then open Xcode > Archive > Distribute
```

---

## 📈 Next sprint ideas

- KOT (kitchen order ticket) splits for multi-station kitchens
- Customer loyalty (auto-detect repeat visitors via phone hash)
- Multi-language UI (Hindi, Marathi, Tamil — `intl` already wired up)
- Cash-drawer kick command via printer
- iPad / tablet POS layout (currently portrait-only)
- Zomato / Swiggy webhook receivers (placeholder UI is in Settings)

---

## 📄 License

Proprietary — © 2026 NamastePOS / Smart IT by Shiv.
