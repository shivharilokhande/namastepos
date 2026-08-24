# FoodFlow — Claude Code Execution Guide
## Step-by-Step Visual Walkthrough

---

## 📋 CHECKLIST: What You Need

Before starting, ensure you have:
- [ ] Claude Code installed (`npm install -g claude` or VS Code Claude extension)
- [ ] Git installed and configured
- [ ] Docker + Docker Compose installed (for local PostgreSQL/Redis)
- [ ] Node.js 18+ installed
- [ ] ~4 hours of uninterrupted time
- [ ] This guide open in another tab

---

## 🎬 EXECUTION FLOW

```
START
  ↓
1. Create Project Directory
  ↓
2. Backend Generation (Phase 1)
  ├─ Prompt 1.1: Setup + DB
  ├─ Prompt 1.2: Auth APIs
  ├─ Prompt 1.3: Menu CRUD
  ├─ Prompt 1.4: Orders + Print
  ├─ Prompt 1.5: Reports
  ├─ Prompt 1.6: Expenses
  ├─ Prompt 1.7: Error Handling + Tests
  └─ Prompt 1.8: Docker + Migrations
  ↓
3. Backend Validation (Run locally)
  ├─ npm install
  ├─ docker-compose up
  ├─ npm run test
  └─ curl http://localhost:3000/health
  ↓
4. Mobile Generation (Phase 2)
  ├─ Prompt 2.1: Expo Setup + Navigation
  ├─ Prompt 2.2: Auth Screens
  ├─ Prompt 2.3: Dashboard
  ├─ Prompt 2.4: POS Order Entry
  ├─ Prompt 2.5: Order Tracking
  ├─ Prompt 2.6: Inventory
  ├─ Prompt 2.7: Reports
  ├─ Prompt 2.8: Settings
  ├─ Prompt 2.9: Printer Integration
  └─ Prompt 2.10: Testing
  ↓
5. Mobile Validation (Run locally)
  ├─ npm install
  ├─ expo start
  └─ Test login flow
  ↓
6. DevOps Setup (Phase 3)
  ├─ Prompt 3.1: CI/CD Pipeline
  └─ Prompt 3.2: Monitoring
  ↓
7. Integration Testing (Phase 4)
  └─ Prompt 4.1: E2E Tests
  ↓
8. Deploy to Production
  ├─ git push
  ├─ GitHub Actions runs tests
  ├─ Auto-deploy to AWS
  └─ Smoke test
  ↓
DONE ✅
```

---

## ⏱️ TIME BREAKDOWN

| Phase | Tasks | Duration |
|-------|-------|----------|
| **Setup** | Create directories, initialize git | 5 min |
| **Backend Gen** | Prompts 1.1–1.8 | 70 min |
| **Backend Test** | Run locally, fix issues | 15 min |
| **Mobile Gen** | Prompts 2.1–2.10 | 80 min |
| **Mobile Test** | Run on device/emulator | 15 min |
| **DevOps** | Prompts 3.1–3.2 | 20 min |
| **E2E Tests** | Prompt 4.1 | 15 min |
| **Total** | | **220 min (3.5 hrs)** |

---

## 🚀 PHASE 0: INITIAL SETUP (5 minutes)

### Step 1: Create Project Structure

```bash
# Create main project directory
mkdir foodflow-project
cd foodflow-project

# Create subdirectories for backend and mobile
mkdir foodflow-backend foodflow-mobile

# Initialize git
git init
git config user.name "Your Name"
git config user.email "your@email.com"

# Create README
cat > README.md << 'EOF'
# FoodFlow — Micro-Food POS Platform

Building with Claude Code autonomous system.

## Structure
- /foodflow-backend — Node.js + Express API
- /foodflow-mobile — React Native + Expo

## Quick Start
See GETTING_STARTED.md
EOF

git add README.md
git commit -m "initial: project setup"
```

### Step 2: Verify Environment

```bash
# Verify Docker
docker --version
docker-compose --version

# Verify Node
node --version  # Should be 18+
npm --version

# Verify Git
git --version

# Optional: Verify Claude Code
which claude || npm list -g claude
```

---

## 🏗️ PHASE 1: BACKEND GENERATION (70 minutes)

### Step 3: Run Prompt 1.1 (Setup + Database)

```bash
cd foodflow-backend

# Copy the entire "PROMPT 1.1: Backend Project Setup" block from FOODFLOW_CLAUDE_CODE_PROMPTS.md
# Paste it into your Claude Code terminal

claude code << 'EOF'
[Paste entire PROMPT 1.1 here]
EOF
```

**What Claude will do:**
- Generate package.json with all dependencies
- Create folder structure (/src, /migrations, /tests)
- Create app.js (Express initialization)
- Create database.js (PostgreSQL connection)
- Create .env.example
- Create Dockerfile + docker-compose.yml
- Create migration SQL file

**Expected output:**
```
✅ package.json created
✅ src/app.js created
✅ src/config/database.js created
✅ migrations/001_init_schema.sql created
✅ Dockerfile created
✅ docker-compose.yml created
... (20+ files)
```

**After Claude finishes:**
```bash
# Validate generated files
ls -la src/
ls -la migrations/
cat package.json | grep "dependencies" -A 15

# Commit
git add .
git commit -m "feat(backend): project setup and database schema"

# Install dependencies (takes ~2 min)
npm install
```

---

### Step 4: Run Prompt 1.2 (Authentication APIs)

```bash
# Claude generates authentication system
claude code << 'EOF'
[Paste entire PROMPT 1.2 here]
EOF
```

**What Claude will do:**
- Create authService.js (business logic)
- Create authController.js (endpoint handlers)
- Create auth.routes.js (route definitions)
- Create auth.test.js (unit + integration tests)
- Create users table migration
- Create validators.js (phone, OTP validation)

**Expected output:**
```
✅ src/services/authService.js created
✅ src/controllers/authController.js created
✅ src/routes/auth.routes.js created
✅ tests/integration/auth.test.js created
✅ migrations/002_add_users_table.sql created
```

**After Claude finishes:**
```bash
# Run tests
npm run test tests/integration/auth.test.js

# You should see:
# ✓ POST /auth/request-otp with valid phone
# ✓ POST /auth/verify-otp with valid OTP
# ✓ POST /auth/refresh token
# ... (4–6 passing tests)

git add .
git commit -m "feat(auth): phone + OTP authentication with Twilio"
```

---

### Step 5: Run Prompts 1.3–1.8 (Same Pattern)

Repeat the pattern above for each prompt:
1. **Prompt 1.3**: Menu CRUD (`npm run test tests/integration/menu.test.js`)
2. **Prompt 1.4**: Orders + Print (`npm run test tests/integration/orders.test.js`)
3. **Prompt 1.5**: Reports (`npm run test tests/integration/reports.test.js`)
4. **Prompt 1.6**: Expenses (`npm run test tests/integration/expenses.test.js`)
5. **Prompt 1.7**: Error Handling + Tests
6. **Prompt 1.8**: Docker + Final setup

After each:
```bash
npm run test
git add .
git commit -m "feat: [feature name]"
```

---

### Step 6: Backend Validation (15 minutes)

```bash
# Start PostgreSQL + Redis
docker-compose up -d postgres redis

# Wait for services to be ready
sleep 10

# Run migrations
npm run migrate

# Seed test data
npm run seed  # (if Claude included this)

# Start API server
npm run dev
# Output: Server listening on http://localhost:3000

# In another terminal, test health check
curl http://localhost:3000/health
# Response: { "status": "ok", "timestamp": "..." }

# Test create menu (requires valid JWT, but shows endpoint works)
curl -X POST http://localhost:3000/businesses/test/menu \
  -H "Content-Type: application/json" \
  -d '{"name": "Test Item", "price": 100, "unit": "piece"}'
# Should get 401 (auth required) — that's correct!

# Stop services
docker-compose down
```

---

## 📱 PHASE 2: MOBILE GENERATION (80 minutes)

### Step 7: Initialize Expo Project

```bash
cd ../foodflow-mobile

# Initialize Expo project
npx create-expo-app . --template expo-template-typescript

# Or use:
# npx expo@latest init --template tabs
```

### Step 8: Run Prompt 2.1 (Expo Setup + Navigation)

```bash
# Generate navigation structure
claude code << 'EOF'
[Paste entire PROMPT 2.1 here]
EOF
```

**What Claude will do:**
- Create app.json (Expo config)
- Create app/ directory with file-based routing
- Setup Redux store with slices
- Create API service with Axios
- Create navigation setup

**After Claude finishes:**
```bash
npm install

# Verify structure
ls -la app/
ls -la components/
ls -la store/

git add .
git commit -m "feat(mobile): Expo setup and navigation"
```

---

### Step 9: Run Prompts 2.2–2.10 (Same Pattern)

Repeat for each prompt:
1. **Prompt 2.2**: Auth Screens (login, OTP verify)
2. **Prompt 2.3**: Dashboard
3. **Prompt 2.4**: POS Order Entry
4. **Prompt 2.5**: Order Tracking
5. **Prompt 2.6**: Inventory
6. **Prompt 2.7**: Reports + Expenses
7. **Prompt 2.8**: Settings
8. **Prompt 2.9**: Printer Integration
9. **Prompt 2.10**: Testing

After each:
```bash
git add .
git commit -m "feat(mobile): [screen name]"
```

### Step 10: Mobile Validation (15 minutes)

```bash
# Start Expo dev server
expo start

# Option A: Run on iOS Simulator
# Press 'i' in terminal
# Simulator opens automatically

# Option B: Run on Android Emulator
# Press 'a' in terminal
# Android Studio emulator must be running

# Option C: Run on physical device
# Download Expo app
# Scan QR code with phone

# Test flows
# 1. Login screen appears ✓
# 2. Enter phone +919876543210 ✓
# 3. Request OTP button works ✓
# 4. (Mock response or real Twilio)
# 5. Navigate to dashboard ✓
```

---

## 🔧 PHASE 3: DEVOPS SETUP (20 minutes)

### Step 11: Run Prompts 3.1–3.2

```bash
cd ../foodflow-backend

# Generate GitHub Actions CI/CD
claude code << 'EOF'
[Paste entire PROMPT 3.1 here]
EOF

# Generate monitoring + logging
claude code << 'EOF'
[Paste entire PROMPT 3.2 here]
EOF
```

**What Claude will do:**
- Create .github/workflows/test-backend.yml
- Create .github/workflows/deploy-production.yml
- Setup Sentry configuration
- Create CloudWatch alarms

```bash
git add .
git commit -m "devops: CI/CD pipeline and monitoring"
```

---

## ✅ PHASE 4: INTEGRATION TESTING (15 minutes)

### Step 12: E2E Tests

```bash
cd ../foodflow-backend

# Run full E2E test suite
claude code << 'EOF'
[Paste entire PROMPT 4.1 here]
EOF

# After Claude generates tests:
npm run test:e2e

# Expected output:
# ✓ Login → Create Order → View Report
# ✓ Offline mode sync
# ✓ Printer failure handling
# (All passing)
```

---

## 🚀 DEPLOYMENT (Automatic after git push)

### Step 13: Push to GitHub

```bash
# Create .gitignore
cat > .gitignore << 'EOF'
node_modules/
.env
.env.local
dist/
build/
.DS_Store
*.log
EOF

git add .gitignore
git commit -m "chore: add gitignore"

# Create GitHub repo and push
git remote add origin https://github.com/yourname/foodflow.git
git branch -M main
git push -u origin main

# GitHub Actions automatically:
# ✓ Runs tests
# ✓ Builds Docker image
# ✓ Pushes to ECR/DockerHub
# ✓ Deploys to AWS Elastic Beanstalk
# ✓ Runs smoke tests
```

---

## 📊 SUCCESS INDICATORS

### Backend ✅
- [ ] `npm run test` — all tests passing
- [ ] `curl http://localhost:3000/health` — returns 200
- [ ] `npm run lint` — no errors
- [ ] Database schema created (11 tables)
- [ ] All 8 prompts completed

### Mobile ✅
- [ ] `expo start` — dev server running
- [ ] App loads on simulator/device
- [ ] Login screen visible
- [ ] Can navigate between tabs
- [ ] All 10 prompts completed

### DevOps ✅
- [ ] GitHub Actions workflow files present
- [ ] Docker image builds successfully
- [ ] docker-compose up works locally
- [ ] Prompts 3.1–3.2 completed

### Integration ✅
- [ ] E2E tests pass
- [ ] Full user flow works (login → order → report)
- [ ] Prompt 4.1 completed

---

## 🐛 TROUBLESHOOTING

### Common Issues

**Issue: `npm install` fails with peer dependency warnings**
```bash
Solution: npm install --legacy-peer-deps
```

**Issue: PostgreSQL connection refused**
```bash
Solution: 
- Check docker-compose is running: docker-compose ps
- If not running: docker-compose up -d postgres redis
- Wait 10 seconds for postgres to initialize
```

**Issue: Port 3000 already in use**
```bash
Solution:
- Change PORT in .env to 3001
- Or: kill -9 $(lsof -t -i :3000)
```

**Issue: Expo app won't connect to backend**
```bash
Solution:
- In .env, set REACT_APP_API_URL=http://YOUR_IP:3000 (not localhost)
- Check firewall allows port 3000
- Restart Expo dev server
```

**Issue: Claude Code times out**
```bash
Solution:
- Break prompt into smaller sub-prompts
- Run one prompt at a time
- Check internet connection
```

---

## 📝 FINAL CHECKLIST

After all phases complete:

```
BACKEND
- [ ] All 8 prompts generated
- [ ] npm test passes (>60% coverage)
- [ ] npm run lint passes
- [ ] Docker setup works
- [ ] Committed to git

MOBILE
- [ ] All 10 prompts generated
- [ ] App runs on simulator/device
- [ ] Navigation works
- [ ] Login flow works
- [ ] Committed to git

DEVOPS
- [ ] GitHub Actions configured
- [ ] Docker image builds
- [ ] Monitoring + logging setup
- [ ] Committed to git

INTEGRATION
- [ ] E2E tests pass
- [ ] Full flow works (login → order → report)
- [ ] Smoke tests pass post-deploy
- [ ] Production ready ✅
```

---

## 🎉 YOU'RE DONE!

You now have:
- ✅ Complete backend API (Node.js + PostgreSQL)
- ✅ Complete mobile app (React Native + Expo)
- ✅ Thermal printer integration (ESC/POS)
- ✅ WhatsApp notifications (Twilio)
- ✅ Financial dashboard (Daily/monthly P&L)
- ✅ Inventory management
- ✅ CI/CD pipeline (GitHub Actions)
- ✅ Docker deployment
- ✅ Comprehensive tests
- ✅ Production-ready MVP

**Total time: 3.5 hours** from start to finish.

**Next steps:**
1. Deploy to AWS
2. Get Twilio + Zomato/Swiggy API keys
3. Recruit 100 pilot users
4. Gather feedback
5. Iterate on v1.1 features

---

## 📞 QUICK REFERENCE

| Command | Purpose |
|---------|---------|
| `npm run dev` | Start API server (local) |
| `npm run test` | Run all tests |
| `npm run lint` | Check code style |
| `expo start` | Start mobile dev server |
| `docker-compose up` | Start PostgreSQL + Redis |
| `git log --oneline` | View commit history |
| `npm run migrate` | Run database migrations |
| `npm run build` | Build for production |

---

**Ready? Start with Step 3 above. Copy Prompt 1.1 and paste into Claude Code.** 🚀

