# FoodFlow Claude Code — Ready-to-Copy Prompts
## Copy-paste directly into Claude Code terminal

---

## 🚀 START HERE: Backend Phase 1

### PROMPT 1.1: Backend Project Setup
**Copy and paste this entire block into Claude Code:**

```
You are a Senior Backend Engineer setting up FoodFlow (micro-food POS system).

TASK: Create complete backend project structure with PostgreSQL database schema.

REQUIREMENTS:
- Node.js 18+, Express 4.x, PostgreSQL 14
- Secure architecture (JWT, parameterized queries, no SQL injection)
- Production-ready folder structure
- Environment-based config (.env)

DELIVERABLES:

1. Initialize Node.js project with these dependencies:
   - express 4.18.x
   - pg 8.10.x (PostgreSQL client)
   - redis 4.6.x
   - bull 4.11.x (job queue)
   - jsonwebtoken 9.1.x
   - dotenv 16.3.x
   - joi 17.x (validation)
   - winston 3.x (logging)
   - cors 2.8.x
   - helmet 7.x (security headers)
   - uuid 9.x
   - jest 29.x (testing)
   - supertest 6.x (API testing)

2. Create folder structure:
   ```
   foodflow-backend/
   ├── src/
   │   ├── config/
   │   │   ├── database.js (PostgreSQL connection pool)
   │   │   ├── env.js (environment variables validation)
   │   │   └── logger.js (Winston setup)
   │   ├── middleware/
   │   │   ├── auth.js (JWT verification)
   │   │   ├── errorHandler.js (global error handler)
   │   │   └── validate.js (request validation)
   │   ├── routes/
   │   │   ├── auth.routes.js
   │   │   ├── business.routes.js
   │   │   ├── menu.routes.js
   │   │   ├── orders.routes.js
   │   │   ├── expenses.routes.js
   │   │   ├── reports.routes.js
   │   │   └── index.js (main router)
   │   ├── controllers/
   │   │   ├── authController.js
   │   │   ├── menuController.js
   │   │   ├── orderController.js
   │   │   ├── expenseController.js
   │   │   └── reportController.js
   │   ├── services/
   │   │   ├── authService.js
   │   │   ├── menuService.js
   │   │   ├── orderService.js
   │   │   ├── reportService.js
   │   │   └── inventoryService.js
   │   ├── utils/
   │   │   ├── validators.js
   │   │   ├── formatters.js
   │   │   └── constants.js
   │   └── app.js (Express app initialization)
   ├── migrations/
   │   └── 001_init_schema.sql (all tables with indexes)
   ├── tests/
   │   ├── unit/
   │   ├── integration/
   │   └── fixtures/
   ├── package.json
   ├── .env.example
   ├── .dockerignore
   ├── Dockerfile
   ├── docker-compose.yml
   ├── jest.config.js
   ├── .eslintrc.json
   └── README.md

3. Create .env.example with all variables:
   NODE_ENV=development
   PORT=3000
   DATABASE_URL=postgresql://user:pass@localhost:5432/foodflow
   REDIS_URL=redis://localhost:6379
   JWT_SECRET=your-secret-key-change-in-production
   JWT_EXPIRY=30m
   TWILIO_ACCOUNT_SID=your-sid
   TWILIO_AUTH_TOKEN=your-token
   TWILIO_PHONE=+1234567890
   LOG_LEVEL=info

4. Create src/app.js with:
   - Express app initialization
   - Middleware setup (CORS, helmet, bodyParser)
   - Route mounting
   - Global error handler
   - Health check endpoint (GET /health)

5. Create src/config/database.js:
   - PostgreSQL connection pool (pg.Pool)
   - Connection validation
   - Export pool for use in services

6. Create src/config/logger.js:
   - Winston logger with console + file transports
   - Log levels: error, warn, info, debug
   - JSON format for production

7. Create migration: migrations/001_init_schema.sql
   - 11 tables: businesses, menu_items, orders, order_items, inventory_transactions, expenses, whatsapp_messages, aggregator_credentials, printer_config, report_cache, users
   - Use UUID primary keys
   - Add indexes on frequently queried columns (businessId, createdAt, aggregatorOrderId)
   - Include ENUM types for status, categories
   - Add created_at, updated_at timestamps
   - Foreign key constraints with CASCADE delete

8. Create package.json with scripts:
   "scripts": {
     "dev": "node src/app.js",
     "build": "echo 'No build needed for Node.js'",
     "start": "NODE_ENV=production node src/app.js",
     "migrate": "node -e \"require('pg').Client(process.env.DATABASE_URL).query(require('fs').readFileSync('./migrations/001_init_schema.sql', 'utf8')).then(() => console.log('Migrations complete')).catch(e => console.error(e))\"",
     "lint": "eslint src/",
     "test": "jest",
     "test:watch": "jest --watch",
     "test:coverage": "jest --coverage"
   }

9. Create docker-compose.yml with services:
   - PostgreSQL 14-alpine (port 5432)
   - Redis 7-alpine (port 6379)
   - API service (port 3000, depends on DB & Redis)
   - Health checks on all services

10. Create Dockerfile:
    - Multi-stage build (builder + runtime)
    - Node 18-alpine
    - Non-root user (nodejs)
    - Minimal image size

11. Create README.md with:
    - Project description
    - Setup instructions
    - Running locally
    - Testing
    - Deployment

CONSTRAINTS:
- No security keys in code (use .env)
- All queries parameterized (prevent SQL injection)
- Proper error handling with try-catch
- Logging on all endpoints
- ISO 8601 timestamps (UTC)

OUTPUT: Complete foodflow-backend directory ready to run.
```

**After Claude Code completes:**
```bash
cd foodflow-backend
npm install
docker-compose up -d postgres redis
npm run migrate
npm run test
```

---

### PROMPT 1.2: Authentication APIs
**Paste this into Claude Code:**

```
You are a Backend Engineer implementing authentication for FoodFlow.

CONTEXT: Backend setup complete. Now build phone + OTP auth system.

TASK: Implement authentication endpoints with Twilio integration.

DELIVERABLES:

1. Create src/services/authService.js with functions:
   - requestOtp(phone) → calls Twilio Verify API, returns verificationSid
   - verifyOtp(phone, code, verificationSid) → validates OTP, creates/loads Business, issues JWT
   - generateTokens(businessId) → creates JWT + refresh token
   - validateToken(token) → verifies JWT signature and expiry
   - refreshAccessToken(refreshToken) → validates refresh token in DB, issues new JWT

2. Create src/controllers/authController.js with endpoints:
   - POST /auth/request-otp
     Input: { phone: "+919876543210" }
     Validation: phone required, valid +91 format
     Logic: Call authService.requestOtp()
     Response: { success: true, verificationSid: "VA...", message: "OTP sent" }
     Error handling: Rate limit (max 3 attempts per 5 mins), network errors

   - POST /auth/verify-otp
     Input: { phone, code, verificationSid }
     Validation: All required, code = 6 digits
     Logic:
       1. Call authService.verifyOtp()
       2. Verify OTP with Twilio
       3. Check if Business exists (phone = unique key)
       4. If new: create Business record
       5. Generate JWT + refresh token
       6. Store refresh token in PostgreSQL (users table)
     Response: { token: "JWT...", refreshToken: "RT...", business: { id, name, city } }
     Error: Invalid OTP → 401, OTP expired → 401

   - POST /auth/refresh
     Input: { refreshToken }
     Headers: Optional Authorization: Bearer {oldToken}
     Logic:
       1. Validate refresh token exists in DB
       2. Check expiry (30 days)
       3. Generate new JWT
     Response: { token: "JWT..." }

   - GET /auth/me
     Headers: Authorization: Bearer {token}
     Logic: Verify JWT, return Business object
     Response: { id, name, city, category, phone, createdAt }

3. Create src/routes/auth.routes.js:
   - Import controllers
   - Define routes
   - Mount on app: app.use('/auth', authRoutes)

4. Create src/middleware/auth.js (JWT verification):
   - Extract token from Authorization header
   - Verify JWT signature
   - Validate expiry
   - Attach business to req.business
   - Next middleware or error

5. Create src/utils/validators.js:
   - validatePhone(phone) → returns true/false
   - validateOtp(code) → 6 digits
   - validateEmail(email) → email format

6. Create users table migration (add to 001_init_schema.sql):
   CREATE TABLE users (
     id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
     businessId UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
     refreshToken VARCHAR(500) NOT NULL,
     expiresAt TIMESTAMP NOT NULL,
     createdAt TIMESTAMP DEFAULT NOW(),
     updatedAt TIMESTAMP DEFAULT NOW()
   );

7. Write tests (tests/integration/auth.test.js):
   - Test POST /auth/request-otp with valid phone → returns verificationSid
   - Test POST /auth/verify-otp with invalid OTP → 401 error
   - Test POST /auth/verify-otp with valid OTP → returns JWT + refreshToken
   - Test GET /auth/me with valid JWT → returns business
   - Test GET /auth/me with invalid JWT → 401 error
   - Test POST /auth/refresh with valid refresh token → returns new JWT

CONSTRAINTS:
- OTP valid for 10 minutes only
- Rate limit: 3 OTP requests per phone per 5 minutes
- JWT expires in 30 minutes
- Refresh token expires in 30 days
- Never log JWT or refresh tokens
- Use Twilio SDK for OTP (don't mock in production)

TESTING: npm run test tests/integration/auth.test.js
```

---

### PROMPT 1.3: Menu Item APIs
**Paste this into Claude Code:**

```
You are a Backend Engineer implementing Menu management.

CONTEXT: Auth system complete. Now build menu CRUD.

TASK: Implement menu item management with stock tracking.

DELIVERABLES:

1. Create src/services/menuService.js with functions:
   - createMenuItem(businessId, data) → INSERT into menu_items
   - getMenuItems(businessId, filters) → SELECT with optional category/isActive filters
   - getMenuItemById(businessId, itemId) → SELECT single item
   - updateMenuItem(businessId, itemId, data) → UPDATE
   - deleteMenuItem(businessId, itemId) → soft delete (set isActive = false)
   - adjustStock(businessId, itemId, deltaQty) → UPDATE stock, INSERT into inventory_transactions

2. Create src/controllers/menuController.js with endpoints:
   - POST /businesses/{businessId}/menu
     Auth: Required (verify business ownership)
     Input: { name, price, costPrice, unit, category, sku, reorderLevel, isVegetarian }
     Validation: name required (max 255), price > 0, unit required
     Logic: Call menuService.createMenuItem()
     Response: Created MenuItem object
     Error: Duplicate SKU → 400 with message

   - GET /businesses/{businessId}/menu
     Query params: ?category=Food&isActive=true
     Logic: Call menuService.getMenuItems(businessId, filters)
     Response: Array of MenuItem objects

   - GET /businesses/{businessId}/menu/{itemId}
     Logic: Call menuService.getMenuItemById()
     Response: Single MenuItem object
     Error: Not found → 404

   - PUT /businesses/{businessId}/menu/{itemId}
     Auth: Required
     Input: { name, price, costPrice, stock, reorderLevel, ... }
     Logic: Call menuService.updateMenuItem()
     Response: Updated MenuItem

   - DELETE /businesses/{businessId}/menu/{itemId}
     Auth: Required
     Logic: Call menuService.deleteMenuItem()
     Response: { deleted: true }

   - PUT /businesses/{businessId}/menu/{itemId}/stock
     Auth: Required
     Input: { newQty }
     Logic:
       1. Get current qty
       2. Calculate delta = newQty - currentQty
       3. Call menuService.adjustStock(businessId, itemId, delta)
       4. INSERT into inventory_transactions (reason: "manual_adjustment")
     Response: { itemId, oldQty, newQty }

3. Create src/routes/menu.routes.js:
   - Import controllers
   - Define routes with auth middleware
   - Mount on app

4. Database validation:
   - Ensure menu_items table has: businessId, name, price, costPrice, stock, reorderLevel, sku (UNIQUE per business), unit, isActive
   - Ensure inventory_transactions table for stock history

5. Write tests (tests/integration/menu.test.js):
   - Create menu item with all fields → succeeds
   - Create with missing name → 400 error
   - Create with duplicate SKU → 400 error
   - Get menu items → returns array
   - Update item price → succeeds
   - Delete item → soft deletes (isActive = false)
   - Adjust stock +5 → inventory_transactions entry created

CONSTRAINTS:
- Only business owner can modify menu
- SKU must be unique per business
- Price > 0, costPrice > 0
- Stock cannot go negative (validation)
- Stock adjustments logged for audit trail

TESTING: npm run test tests/integration/menu.test.js
```

---

### PROMPT 1.4: Order Creation & Management
**Paste this into Claude Code:**

```
You are a Backend Engineer implementing Order management.

CONTEXT: Menu system complete. Now build order creation and status tracking.

TASK: Implement order CRUD with thermal printer token generation.

DELIVERABLES:

1. Create src/services/orderService.js with functions:
   - createOrder(businessId, orderData) 
     Logic:
       1. Validate all items exist in menu
       2. Calculate total (sum of item prices × qty)
       3. Generate next orderNo (auto-increment per business)
       4. INSERT into orders table
       5. INSERT each item into order_items table
       6. Deduct stock from inventory_transactions (reason: "sold")
       7. Return created order
   
   - getOrders(businessId, filters)
     Filters: date (YYYY-MM-DD), source (dine_in, takeaway, zomato, swiggy), status
     Logic: SELECT with WHERE clauses, ORDER BY createdAt DESC
   
   - getOrderById(businessId, orderId)
   
   - updateOrderStatus(businessId, orderId, newStatus)
     Validate: pending → ready → collected OR pending → cancelled
     Return: updated order
   
   - generateTokenPrint(order)
     Logic: Format ESC/POS commands for thermal printer
     Return: ESC/POS command string

2. Create src/controllers/orderController.js with endpoints:
   - POST /businesses/{businessId}/orders
     Auth: Required
     Input: { source, items: [{menuItemId, qty, customization}], tableNo?, customerPhone?, customerName?, paymentMethod, total }
     Validation:
       - All menuItemIds exist
       - Total = sum(items)
       - If source = dine_in: tableNo required
     Logic:
       1. Call orderService.createOrder()
       2. Trigger token print (call printerService)
       3. Return created order
     Response: { id, orderNo, status: "pending", items, total, createdAt }

   - GET /businesses/{businessId}/orders?date=2024-01-15&source=dine_in&status=pending
     Logic: Call orderService.getOrders(businessId, filters)
     Response: { data: [...], pagination: { total, limit, offset } }

   - GET /businesses/{businessId}/orders/{orderId}
     Response: Full order details including items

   - PUT /businesses/{businessId}/orders/{orderId}/status
     Auth: Required
     Input: { status, cancelReason? }
     Validation: Valid status transition
     Logic:
       1. Call orderService.updateOrderStatus()
       2. If status = "ready": trigger WhatsApp notification
       3. If status = "collected": update collectedAt timestamp
       4. If status = "cancelled": update cancelledAt and reason
     Response: Updated order

   - POST /businesses/{businessId}/orders/{orderId}/print
     Auth: Required
     Logic:
       1. Get order details
       2. Call orderService.generateTokenPrint()
       3. Send to printer via printerService
     Response: { status: "print_sent", printerQueue: "..." }

3. Create src/services/printerService.js:
   - printToken(order)
     Logic:
       1. Format ESC/POS commands (see format below)
       2. Send to printer (backend abstraction, mobile app handles actual printing)
       3. Log print attempt
     Return: { success, message, timestamp }

4. ESC/POS Token Format:
   ESC/P standard thermal printer format:
   - Initialize: ESC @ (reset)
   - Font size: ESC ! (set emphasized mode)
   - Alignment: ESC a (center, left, right)
   - Text: Raw UTF-8 (supports Devanagari: दोसा, चाय)
   - Cut: GS V (full cut)
   - Raw commands: Generate command string

   Token template:
   =====================================
           BUSINESS NAME
   =====================================
   ORDER #42                       2024-01-15
   -----------------------------------
   MASALA DOSA              x2    ₹160
     (extra spice, no onions)
   CHAI, TEA                x1    ₹20
   -----------------------------------
   SUBTOTAL: ₹180
   TAX: ₹0
   TOTAL: ₹180
   
   TABLE: 3
   CUSTOMER: +919876543210
   STATUS: PENDING
   =====================================

5. Create src/routes/orders.routes.js with auth middleware

6. Database: Update orders, order_items tables
   - orders.orderNo should auto-increment per businessId
   - Ensure foreign keys are correct

7. Write tests (tests/integration/orders.test.js):
   - Create order with 2 items → success
   - Total calculation correct
   - Stock deducted from inventory
   - Order appears in GET /orders
   - Update status pending → ready → collected
   - Cancel order with reason → works
   - Print token generates ESC/POS commands

CONSTRAINTS:
- orderNo auto-increments per business (not global)
- Total must equal sum of items (validation)
- Stock deduction happens immediately (no pending state)
- Status transitions: pending → ready, ready → collected, pending → cancelled only
- Customer phone optional (used for WhatsApp notifications)

TESTING: npm run test tests/integration/orders.test.js
```

---

## Continue with Prompts 1.5–1.8

Each follows same pattern. **Ready to start?** Copy Prompt 1.1 and paste into Claude Code now.

After each prompt completes, run:
```bash
npm run test
git add .
git commit -m "feat: {feature name}"
```

---

## Time to First Success

- **Prompt 1.1**: 15 minutes (setup + DB schema)
- **Prompt 1.2**: 20 minutes (auth + OTP)
- **Prompt 1.3**: 15 minutes (menu CRUD)
- **Prompt 1.4**: 20 minutes (orders + printing)
- **Total so far**: ~70 minutes to working backend

Then Phase 2 (mobile) same timeline.

**Total MVP: 3–4 hours from start to finish.** 🚀

