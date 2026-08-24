# FoodFlow — Claude Code Autonomous Build System
## Master Orchestration for Complete App Generation

---

## OVERVIEW

This system uses **Claude Code** to autonomously build FoodFlow in phases:

1. **Backend generation** (Node.js + Express + PostgreSQL)
2. **Mobile app generation** (React Native + Expo)
3. **DevOps setup** (Docker, CI/CD, deployment)
4. **Integration testing** (API + mobile E2E)

Each phase is **fully autonomous** — no manual intervention needed between phases.

---

## PHASE 1: BACKEND GENERATION (Days 1–4)

### Prompt 1.1: Project Setup & Database Schema

```
You are a Senior Backend Engineer for FoodFlow (POS for micro-food businesses).

TASK: Create complete backend project structure with PostgreSQL schema.

DELIVERABLES:
1. Initialize Node.js project (package.json with dependencies)
2. Create .env.example with all required variables
3. Generate PostgreSQL migration: 001_init_schema.sql (all 11 tables)
4. Create /src directory structure (controllers, services, models, routes, middleware)
5. Setup Express app.js with middleware
6. Create database connection pool (pg library)
7. Create logger setup (Winston)

CONSTRAINTS:
- Node.js 18+, Express 4.x, pg 8.x
- Use parameterized queries (prevent SQL injection)
- Add indexes on frequently queried columns
- Include ENUM types for status, categories
- Use UUID for primary keys
- Add created_at, updated_at timestamps on all tables

OUTPUT: Complete /foodflow-backend directory ready to npm install
```

### Prompt 1.2: Authentication APIs

```
You are a Backend Engineer implementing authentication for FoodFlow.

TASK: Build phone + OTP authentication system using Twilio.

DELIVERABLES:
1. POST /auth/request-otp — request OTP via SMS
   - Input: phone (string, +91 format)
   - Use Twilio Verify API
   - Response: { success, verificationSid }

2. POST /auth/verify-otp — verify OTP and issue JWT
   - Input: phone, code, verificationSid
   - Create Business record if first-time user
   - Issue JWT (30-min expiry) + refresh token (30-day)
   - Store refresh token in PostgreSQL
   - Response: { token, refreshToken, business }

3. POST /auth/refresh — refresh JWT
   - Input: refreshToken
   - Validate against database
   - Issue new JWT
   - Response: { token }

4. GET /auth/me — get current user info
   - Requires Authorization: Bearer {token}
   - Response: Business object

IMPLEMENTATION:
- Create authController.js (4 endpoints)
- Create authService.js (business logic)
- Create authRoutes.js
- Setup JWT middleware (verify token)
- Add error handling (invalid OTP, expired token)
- Write unit tests (40% coverage min)

CONSTRAINTS:
- No passwords, only OTP-based auth
- JWT secret from environment
- Rate limit: 3 OTP attempts per phone per 5 mins
- OTP valid for 10 minutes

OUTPUT: /src/routes/auth.routes.js, /src/controllers/authController.js, /src/services/authService.js + tests
```

### Prompt 1.3: Menu Item APIs (CRUD)

```
You are a Backend Engineer implementing Menu Item management.

TASK: Build complete CRUD for menu items with stock tracking.

DELIVERABLES:
1. POST /businesses/{businessId}/menu — create menu item
2. GET /businesses/{businessId}/menu — list items (with filters: category, isActive)
3. GET /businesses/{businessId}/menu/{itemId} — get item details
4. PUT /businesses/{businessId}/menu/{itemId} — update item
5. DELETE /businesses/{businessId}/menu/{itemId} — soft delete
6. PUT /businesses/{businessId}/menu/{itemId}/stock — adjust stock quantity

REQUEST VALIDATION:
- name: required, max 255 chars
- price: required, decimal, > 0
- costPrice: optional, decimal, > 0
- sku: optional, unique per business
- unit: required (piece, kg, liter, gram)
- stock: optional, default 0
- reorderLevel: optional, default 10

RESPONSE: MenuItem object with id, businessId, name, price, stock, etc.

BUSINESS LOGIC:
- Only business owner can modify their menu
- Duplicate SKU validation
- Stock adjustments logged to inventory_transactions table
- Low stock alerts (qty < reorderLevel)

OUTPUT: /src/routes/menu.routes.js, /src/controllers/menuController.js, /src/services/menuService.js + tests
```

### Prompt 1.4: Order Creation & Printing

```
You are a Backend Engineer implementing Order management with token printing.

TASK: Build order creation, status tracking, and token print trigger.

DELIVERABLES:
1. POST /businesses/{businessId}/orders — create order
   - Input: items[], source, tableNo (if dine-in), customerPhone, total, paymentMethod
   - Generate orderNo (auto-increment per business)
   - Deduct stock from inventory_transactions
   - Return: Order object with orderId, orderNo, status: pending

2. GET /businesses/{businessId}/orders — list orders
   - Filters: date, source, status
   - Response: Array of orders, pagination

3. GET /businesses/{businessId}/orders/{orderId} — get order details

4. PUT /businesses/{businessId}/orders/{orderId}/status — update status
   - pending → ready → collected → cancelled
   - Trigger WhatsApp on status change
   - Response: Updated order

5. POST /businesses/{businessId}/orders/{orderId}/print — trigger print
   - Generate ESC/POS thermal printer format
   - Response: Print job status

TOKEN PRINT FORMAT (ESC/POS):
```
=====================================
         BUSINESS NAME
=====================================
ORDER #42                       
2024-01-15 10:30 AM             
-----------------------------------
MASALA DOSA            x2
  (extra spice)
CHAI, TEA              x1
-----------------------------------
TOTAL: ₹160
TABLE: 3
CUSTOMER: +919876543210
STATUS: PENDING
=====================================
```

BUSINESS LOGIC:
- Stock deduction happens on order creation
- Order queue uses WebSocket for real-time updates (future)
- Order items stored in order_items junction table
- Validate total = sum(items * qty)

OUTPUT: /src/routes/orders.routes.js, /src/controllers/orderController.js, /src/services/orderService.js + formatters/tokenPrinter.js
```

### Prompt 1.5: Reports & Financial Dashboard

```
You are a Backend Engineer implementing Financial Reports.

TASK: Build daily and monthly P&L dashboard.

DELIVERABLES:
1. GET /businesses/{businessId}/reports/daily?date=2024-01-15
   - Calculate: totalRevenue (sum of order totals), totalExpenses (sum of expenses), profit
   - Group expenses by category
   - Group revenue by source (dine-in, takeaway, zomato, swiggy)
   - Item-wise sales (top 5 items by qty)
   - Response:
     {
       date: "2024-01-15",
       revenue: { dineIn: 2400, takeaway: 800, zomato: 1200, swiggy: 600, total: 5000 },
       expenses: { ingredients: 1500, fuel: 300, labor: 0, rent: 0, total: 1800 },
       profit: 3200,
       margin: 64,
       orderCount: 23,
       itemWiseSales: [ { itemId, itemName, qty, revenue } ]
     }

2. GET /businesses/{businessId}/reports/monthly?month=2024-01&export=json|excel|pdf
   - Aggregate daily reports into monthly
   - Calculate month-over-month growth
   - Export formats: JSON, Excel (via xlsx library), PDF (via pdfkit)

BUSINESS LOGIC:
- Cache reports in report_cache table (24-hour TTL)
- Use PostgreSQL aggregation (GROUP BY)
- Handle timezone (India IST)

PERFORMANCE:
- Daily report: <100ms (cached)
- Monthly report: <500ms (computed on-demand)

OUTPUT: /src/routes/reports.routes.js, /src/services/reportService.js + export formatters
```

### Prompt 1.6: Expenses API

```
You are a Backend Engineer implementing Expense tracking.

TASK: Build expense logging and categorization.

DELIVERABLES:
1. POST /businesses/{businessId}/expenses — create expense
   - Input: category (fuel, ingredients, labor, rent, utilities, packaging, other), amount, description, date, receiptUrl (optional)
   - Response: Expense object

2. GET /businesses/{businessId}/expenses?startDate=2024-01-01&endDate=2024-01-31
   - Response: Array of expenses, can filter by category

3. DELETE /businesses/{businessId}/expenses/{expenseId}
   - Soft delete (set deletedAt)

VALIDATION:
- category: enum (fuel, ingredients, labor, rent, utilities, packaging, other)
- amount: required, decimal, > 0
- date: required, date format
- description: optional, max 500 chars

OUTPUT: /src/routes/expenses.routes.js, /src/controllers/expenseController.js, /src/services/expenseService.js
```

### Prompt 1.7: Error Handling & Testing

```
You are a Backend Engineer finalizing error handling and test coverage.

TASK: Implement global error handler and write integration tests.

DELIVERABLES:
1. Global error handler middleware (errorHandler.js)
   - Catch all errors, return consistent { error, message, statusCode }
   - Log errors to Winston logger
   - Never expose internal stack traces

2. Integration tests (Jest + Supertest)
   - Test each endpoint (auth, menu, orders, reports, expenses)
   - Test database transactions
   - Test validation errors
   - Minimum 60% coverage

3. Test database setup
   - Create test PostgreSQL instance (or use testcontainers)
   - Seed test data (1 business, 5 menu items, 10 orders)
   - Cleanup after each test

4. Postman collection (auto-generated from OpenAPI)
   - Include all endpoints
   - Include environment variables

OUTPUT: /src/middleware/errorHandler.js, /tests/integration/, postman-collection.json
```

### Prompt 1.8: Docker & Database Setup

```
You are a DevOps Engineer setting up Docker.

TASK: Create Docker configuration and database initialization.

DELIVERABLES:
1. Dockerfile
   - Multi-stage build (builder + runtime)
   - Node.js 18-alpine
   - Minimal image size

2. docker-compose.yml
   - PostgreSQL 14 service
   - Redis 7 service (for job queue, future)
   - API service
   - Health checks on all services

3. .dockerignore file

4. .env.example (complete)

5. npm scripts
   - npm run dev (local development)
   - npm run build (production build)
   - npm run migrate (run migrations)
   - npm run seed (seed test data)
   - npm run test (Jest tests)

OUTPUT: /Dockerfile, /docker-compose.yml, complete npm scripts in package.json
```

---

## PHASE 2: MOBILE APP GENERATION (Days 5–8)

### Prompt 2.1: React Native Project Setup

```
You are a Senior Mobile Engineer building FoodFlow mobile app with React Native + Expo.

TASK: Initialize complete React Native + Expo project with navigation structure.

DELIVERABLES:
1. Create Expo project with TypeScript support
2. Setup app router (Expo Router for file-based navigation)
3. Create folder structure:
   - /app (screens)
   - /components (reusable components)
   - /hooks (custom hooks)
   - /services (API client)
   - /store (Redux)
   - /utils (helpers)

4. Setup Redux Toolkit store with slices:
   - authSlice (token, refreshToken, business)
   - ordersSlice (orders list, current order)
   - menuSlice (menu items)
   - settingsSlice (printer config, etc.)

5. Setup Axios client with interceptors
   - Add JWT token to all requests
   - Handle 401 (refresh token)
   - Retry logic

6. Setup navigation
   - Auth stack (login, OTP verify, onboarding)
   - Home stack (dashboard with tabs: POS, Orders, Inventory, Reports)

7. Environment setup (.env.example)
   - REACT_APP_API_URL
   - REACT_APP_ENV

OUTPUT: Complete Expo project structure, ready to run `expo start`
```

### Prompt 2.2: Authentication Screens

```
You are a Mobile Engineer building authentication screens.

TASK: Create phone login + OTP verification flow.

DELIVERABLES:
1. /app/(auth)/login.js
   - Phone input field (text format +91XXXXXXXXXX)
   - [Request OTP] button
   - Input validation (10 digits after +91)
   - Loading spinner during API call
   - Error toast on failure

2. /app/(auth)/otp-verify.js
   - OTP input (6 digits)
   - [Verify] button
   - Timer (10 mins until OTP expires)
   - [Resend OTP] link
   - Loading spinner
   - Success → navigate to dashboard

3. Redux integration
   - authSlice stores token, refreshToken
   - AsyncStorage backup (encryption for production)

4. Error handling
   - Invalid phone format → show validation error
   - Invalid OTP → show "Wrong OTP, try again"
   - OTP expired → show "OTP expired, request new one"
   - Network error → retry button

OUTPUT: /app/(auth)/login.js, /app/(auth)/otp-verify.js + Redux slice
```

### Prompt 2.3: Dashboard Screen

```
You are a Mobile Engineer building main dashboard.

TASK: Create dashboard with KPI cards and navigation tabs.

DELIVERABLES:
1. /app/(home)/index.js (Dashboard)
   - KPI cards (top): Today's Revenue | Expenses | Profit (fetched from API)
   - Quick action buttons: [New Order] [New Expense] [View Orders]
   - Live pending orders list (5 most recent)
   - Notifications banner (low stock alerts, etc.)
   - Bottom tabs: POS | Orders | Inventory | Reports | Settings

2. Refresh logic
   - Pull-to-refresh on dashboard
   - Auto-refresh every 30 seconds (dashboard stays updated)

3. Loading states
   - Skeleton loader while KPIs load
   - Placeholder text if no orders today

OUTPUT: /app/(home)/index.js + components for KPI cards
```

### Prompt 2.4: POS (Order Entry) Screen

```
You are a Mobile Engineer building the POS order entry screen.

TASK: Create intuitive order entry with item selection and cart.

DELIVERABLES:
1. /app/(home)/pos/new-order.js
   - Category tabs (Food, Beverage, Dessert) — scrollable horizontally
   - Item list: Name | Price | [+] / [-] qty selector
   - Add to cart on qty > 0
   - Cart section (sticky bottom):
     - List of selected items with qty, price
     - Subtotal display
     - [Clear] button
     - [Confirm Order] button

2. /app/(home)/pos/confirm-order.js
   - Modal: Order summary
   - Table selector (1–50, or "Takeaway" toggle)
   - Customer phone (optional, for WhatsApp)
   - Payment method selector (Cash, UPI, Card)
   - Total display
   - [Confirm] button → POST to backend → print token

3. Keyboard shortcuts (for faster entry)
   - Number keys → qty input
   - Enter → confirm order
   - Esc → clear cart

4. Offline mode
   - If no internet: queue order locally (AsyncStorage)
   - Sync when online

OUTPUT: /app/(home)/pos/new-order.js, /app/(home)/pos/confirm-order.js + components
```

### Prompt 2.5: Order Tracking Screen

```
You are a Mobile Engineer building order status tracking.

TASK: Create live order queue with status management.

DELIVERABLES:
1. /app/(home)/orders/index.js (Order List)
   - Tabs: Pending | Ready | Collected
   - Each order card: Order #, Time, Items, Total, Customer Phone
   - [Ready] button (changes status + sends WhatsApp)
   - [Collected] button (archives order)
   - [Reprint] button
   - [Cancel] button (requires reason)
   - Auto-refresh via WebSocket or polling (2 sec)

2. /app/(home)/orders/[orderId].js (Order Details)
   - Full order details
   - Item breakdown with customizations
   - Order timeline (created → ready → collected)
   - Action buttons
   - WhatsApp message history

3. Real-time sync
   - Use Socket.io or polling (GET /orders every 2 sec)
   - Show "live" indicator if synced

OUTPUT: /app/(home)/orders/index.js, /app/(home)/orders/[orderId].js + Redux slice
```

### Prompt 2.6: Inventory Management Screen

```
You are a Mobile Engineer building inventory tracking.

TASK: Create stock management with low-stock alerts.

DELIVERABLES:
1. /app/(home)/inventory/index.js
   - List all menu items with current stock
   - Item card: Name | Current Qty | Reorder Level | Unit
   - [+] / [-] buttons to adjust qty
   - RED highlight if qty < reorderLevel
   - [Adjust Stock] button → modal for exact qty input

2. /app/(home)/inventory/[itemId].js
   - Item detail page
   - Stock history (inventory_transactions log)
   - Manual adjustment form
   - Reason dropdown (purchase, sale, waste, adjustment)

3. Alerts
   - Low stock notification badge
   - Toast: "Dosa stock low! (2 pcs left)"

OUTPUT: /app/(home)/inventory/index.js, /app/(home)/inventory/[itemId].js
```

### Prompt 2.7: Expenses & Reports

```
You are a Mobile Engineer building financial screens.

TASK: Create expense logging and P&L dashboard.

DELIVERABLES:
1. /app/(home)/expenses/index.js
   - List expenses (today)
   - [+] New Expense button
   - Expense form: Category | Amount | Description | Date | Receipt upload
   - Delete expense (with confirmation)

2. /app/(home)/reports/daily.js
   - KPI cards: Revenue | Expenses | Profit | Margin
   - Revenue breakdown chart (Dine-in | Takeaway | Zomato | Swiggy)
   - Expense breakdown chart (Ingredients | Fuel | Labor | Other)
   - Top 5 items table
   - Date picker (select any past date)

3. /app/(home)/reports/monthly.js
   - Same charts, but monthly aggregation
   - [Export] button → export as PDF, Excel, or WhatsApp

4. Charts
   - Use `react-native-svg-charts` for bar/pie charts
   - Lightweight, no dependency hell

OUTPUT: /app/(home)/expenses/index.js, /app/(home)/reports/daily.js, /app/(home)/reports/monthly.js
```

### Prompt 2.8: Settings & Printer Configuration

```
You are a Mobile Engineer building settings and hardware configuration.

TASK: Create settings screen for printer, business info, and integrations.

DELIVERABLES:
1. /app/(home)/settings/index.js
   - Settings menu with sections:
     - Business Info
     - Printer Setup
     - Aggregators (Zomato, Swiggy)
     - Notifications
     - Logout

2. /app/(home)/settings/printer-setup.js
   - Printer type selector (Bluetooth, USB, Network)
   - Bluetooth device list (scanned)
   - Pair button
   - Test print button
   - Baud rate selector

3. /app/(home)/settings/aggregators.js
   - Zomato API key input (show as password)
   - Swiggy API key input
   - Toggle ON/OFF for each

4. /app/(home)/settings/business-info.js
   - Edit business name, city, category, GSTIN, bank details
   - Upload logo

OUTPUT: /app/(home)/settings/index.js + subpages
```

### Prompt 2.9: Thermal Printer Integration

```
You are a Mobile Engineer implementing thermal printer communication.

TASK: Create ESC/POS thermal printer printing system.

DELIVERABLES:
1. Install library: npm install react-native-thermal-receipt-printer
2. Create /services/printerService.js
   - Function: printToken(order) → generates ESC/POS commands
   - Connect to Bluetooth printer
   - Send commands to printer
   - Handle timeout and errors

3. ESC/POS format
   - Initialize printer
   - Set font size, alignment
   - Print business name
   - Print order details
   - Print total
   - Cut paper
   - Reset printer

4. Error handling
   - Printer not connected → show error modal
   - Print timeout → retry button
   - Success → confirmation toast

OUTPUT: /services/printerService.js + Bluetooth connection management
```

### Prompt 2.10: Integration & Testing

```
You are a Mobile Engineer finalizing integration and E2E tests.

TASK: Write comprehensive E2E tests and integration checks.

DELIVERABLES:
1. Detox E2E tests
   - Login flow
   - Create order
   - Verify order appears in list
   - Mark order ready
   - View report

2. Jest unit tests
   - Redux slices
   - API service (mock HTTP)
   - Utility functions

3. Manual testing checklist
   - Login with valid phone → works
   - Create order with 3 items → token prints
   - View dashboard → KPIs load
   - Printer disconnects → error handled gracefully

OUTPUT: /tests/e2e/, /tests/unit/ + testing documentation
```

---

## PHASE 3: DEVOPS & DEPLOYMENT (Days 9–10)

### Prompt 3.1: CI/CD Pipeline

```
You are a DevOps Engineer setting up GitHub Actions CI/CD.

TASK: Create automated testing, building, and deployment pipeline.

DELIVERABLES:
1. .github/workflows/test-backend.yml
   - Trigger: On PR to develop
   - Steps:
     - Install dependencies
     - Run linter (ESLint)
     - Run unit tests (Jest)
     - Run integration tests (Supertest)
     - Upload coverage

2. .github/workflows/deploy-production.yml
   - Trigger: On push to main
   - Steps:
     - Build Docker image
     - Push to DockerHub / ECR
     - Deploy to AWS Elastic Beanstalk (or DigitalOcean)
     - Run smoke tests
     - Notify on Slack

3. .github/workflows/build-mobile.yml
   - Trigger: On tag (v1.0.0)
   - Steps:
     - Build APK (Android)
     - Build IPA (iOS, requires Mac runner)
     - Upload to Expo / EAS Build

OUTPUT: Complete .github/workflows/ directory
```

### Prompt 3.2: Monitoring & Logging

```
You are a DevOps Engineer setting up monitoring.

TASK: Configure error tracking, logging, and performance monitoring.

DELIVERABLES:
1. Sentry setup (error tracking)
   - Initialize in app.js (backend) and app.tsx (mobile)
   - Capture all errors
   - Set environment (dev, staging, prod)

2. CloudWatch setup (AWS)
   - Log backend API requests
   - Monitor database queries
   - Track API latency (p50, p95, p99)

3. Alerts
   - Alert if API uptime < 99%
   - Alert if error rate > 1%
   - Alert if database connection pool > 80%

OUTPUT: Sentry setup guide, CloudWatch alarms configuration
```

---

## PHASE 4: INTEGRATION TESTING (Day 11)

### Prompt 4.1: End-to-End Testing

```
You are a QA Engineer writing E2E tests.

TASK: Write comprehensive tests covering entire user flows.

DELIVERABLES:
1. Test: Login → Create Order → View Report
   - Start API server
   - Start mobile app
   - Login with test phone
   - Create dine-in order with 2 items
   - Verify order appears in dashboard
   - Mark order ready
   - Verify WhatsApp message sent
   - View daily report, verify totals correct

2. Test: Offline mode
   - Create order while offline
   - Verify order queued locally
   - Come online
   - Verify order syncs to backend

3. Test: Printer failure
   - Disable Bluetooth
   - Try to print
   - Verify error handling

OUTPUT: E2E test suite (Detox or Cypress)
```

---

## QUICK START: HOW TO USE THIS

### Step 1: Prepare Environment
```bash
# Install Claude Code
npm install -g claude

# Create project directory
mkdir foodflow && cd foodflow

# Initialize git
git init
git config user.name "Your Name"
git config user.email "your@email.com"

# Create README
echo "# FoodFlow" > README.md
git add README.md
git commit -m "initial commit"
```

### Step 2: Execute Phase 1 (Backend)

```bash
# Copy this prompt to Claude Code
claude code << 'EOF'
{Phase 1.1 prompt from above}
EOF

# Wait for completion, then commit
git add .
git commit -m "feat: backend setup and database schema"

# Repeat for Prompts 1.2–1.8
```

### Step 3: Execute Phase 2 (Mobile)

```bash
# Follow same pattern for Phase 2 prompts
```

### Step 4: Test & Deploy

```bash
# Start backend
npm run dev

# Start mobile app
expo start

# Run tests
npm test

# Deploy
git push origin main
```

---

## AUTOMATION RULES

**Auto-Selection Protocol:** Claude Code will auto-detect:
- **Language**: JavaScript/TypeScript → activate Node.js patterns
- **Framework**: Express detected → apply backend patterns
- **Framework**: React Native detected → apply mobile patterns
- **Database**: PostgreSQL → apply SQL patterns + migrations
- **Task**: Testing → activate Jest + Supertest patterns

**Parallel Execution:**
- Prompts 1.1–1.4 can run in parallel (different features)
- Prompts 2.1–2.5 can run in parallel (mobile screens)
- Phases 1 & 2 run in parallel (backend ≠ mobile)

**Conflict Resolution:**
- If naming conflicts arise, use namespace (backend/src, mobile/src)
- If version conflicts arise, pin versions in package.json

---

## SUCCESS CHECKLIST

After each phase:
- [ ] All files created (no errors)
- [ ] Dependencies installed (npm install succeeds)
- [ ] Project builds (npm run build succeeds)
- [ ] Tests pass (npm test succeeds)
- [ ] Linting passes (npm run lint succeeds)
- [ ] Code coverage > 60%
- [ ] Committed to git with meaningful message

---

## ESTIMATED TIMELINE

| Phase | Prompts | Time | Output |
|-------|---------|------|--------|
| 1 | 8 | 4 hours | Complete backend API |
| 2 | 10 | 5 hours | Complete mobile app |
| 3 | 2 | 1 hour | Docker + CI/CD |
| 4 | 1 | 1 hour | E2E tests |
| **Total** | **21** | **11 hours** | **Production-ready MVP** |

---

## NOTES

1. **You don't type these prompts manually** — copy-paste each section into Claude Code
2. **Claude Code will auto-generate ALL code** — no manual editing needed
3. **Each prompt is self-contained** — can be run independently
4. **Iterative refinement** — if output isn't perfect, re-run the same prompt with refinement notes

**Ready to build? Copy the prompts above into Claude Code and let it generate!** 🚀

