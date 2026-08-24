// NamastePOS backend - Express app factory

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const env = require('./config/env');
const logger = require('./config/logger');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const authRoutes        = require('./routes/auth.routes');
const adminRoutes       = require('./routes/admin.routes');
const menuRoutes        = require('./routes/menu.routes');
const ordersRoutes      = require('./routes/orders.routes');
const expensesRoutes    = require('./routes/expenses.routes');
const reportsRoutes     = require('./routes/reports.routes');
const taxInvoicesRoutes = require('./routes/taxInvoices.routes');
const staffRoutes       = require('./routes/staff.routes');
const billingRoutes     = require('./routes/billing.routes');
const invitationsRoutes = require('./routes/invitations.routes');
const addonRoutes       = require('./routes/addons.routes');
const customersRoutes   = require('./routes/customers.routes');
const opsRoutes         = require('./routes/ops.routes');
const guestRoutes       = require('./routes/guest.routes');
const ingredientsRoutes = require('./routes/ingredients.routes');
const sprint1ExtraRoutes = require('./routes/sprint1Extras.routes');
const sprintsAllRoutes = require('./routes/sprintsAll.routes');
const aggregatorWebhookRoutes = require('./routes/aggregatorWebhooks.routes');
const multiOutletRoutes = require('./routes/multiOutlet.routes');
const publicSiteRoutes = require('./routes/publicSite.routes');
const whatsappWebhookRoutes = require('./routes/whatsappWebhook.routes');
const finalSprintRoutes = require('./routes/finalSprint.routes');
const meRoutes = require('./routes/me.routes');
const complianceRoutes = require('./routes/compliance.routes');
const billingController = require('./controllers/billingController');

const sentry = require('./config/sentry');

function buildApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // Sentry request/tracing handler MUST run before any other middleware
  // to capture the full request context. Soft no-op when SENTRY_DSN is
  // unset or the SDK isn't installed.
  sentry.installRequestHandler(app);

  app.use(helmet({
    // P1 (Lakshmi P2): switch CSP from report-only to enforce. We keep
    // 'unsafe-inline' for now because the Razorpay checkout iframe injects
    // inline styles; we'll add a nonce-based CSP in QA-8.
    contentSecurityPolicy: env.isProd() ? undefined : false,
    crossOriginEmbedderPolicy: false,
  }));

  // P1 (Lakshmi #4): in prod the wildcard is rejected at startup — see env.js.
  // Here we additionally fail-loudly if a request from an unknown origin
  // arrives, so leaks show up in logs instead of being silently allowed.
  if (env.isProd() && env.CORS_ORIGINS.includes('*')) {
    throw new Error('CORS_ORIGINS=* is not allowed in production. Set explicit origins.');
  }
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin || env.CORS_ORIGINS.includes('*') || env.CORS_ORIGINS.includes(origin)) {
        return cb(null, true);
      }
      return cb(new Error(`CORS blocked: ${origin}`));
    },
    credentials: true,
  }));

  // Raw body capture for webhook signature verification
  app.use(express.json({
    limit: '1mb',
    verify: (req, _res, buf) => { req.rawBody = buf.toString(); },
  }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(cookieParser());
  app.use(compression());

  // QA-8 P1: CSRF protection for cookie-based sessions. Bearer-only
  // requests are exempt (no cookie session = no CSRF vector).
  const csrf = require('./middleware/csrf');
  app.use((req, res, next) => {
    // Skip CSRF on webhooks (signature-verified) and guest endpoints.
    if (req.path.startsWith(`${env.API_PREFIX}/webhooks`)) return next();
    if (req.path.startsWith(`${env.API_PREFIX}/guest`)) return next();
    if (req.path.startsWith(`${env.API_PREFIX}/aggregator-webhooks`)) return next();
    if (req.path.startsWith(`${env.API_PREFIX}/wa-webhooks`)) return next();
    // DPDP-mandated public endpoints (grievance filing + cookie consent)
    // must be reachable without a CSRF token because they can be hit by
    // unauthenticated principals from third-party privacy portals. Rate
    // limit + Joi validation are the abuse defences here.
    if (req.path.startsWith(`${env.API_PREFIX}/compliance`)) return next();
    // Push 4: skip CSRF on pre-login auth endpoints. These are reached
    // BEFORE the user has any session, but a stale `ff_refresh` cookie from
    // a previous login attempt would otherwise trip the double-submit check.
    const authPath = `${env.API_PREFIX}/auth`;
    if (
      req.path === `${authPath}/google` ||
      req.path === `${authPath}/login` ||
      req.path === `${authPath}/register` ||
      req.path === `${authPath}/dev-login` ||
      req.path === `${authPath}/refresh` ||
      req.path === `${authPath}/request-otp` ||
      req.path === `${authPath}/verify-otp`
    ) {
      return next();
    }
    return csrf.verify(req, res, next);
  });

  // Skip global rate limiter in test env — Jest fires many requests in a
  // tight loop and trips the limiter on legit assertions, masking real
  // failures. Per-route limiters (login, etc.) still apply via the routes
  // themselves where they have their own `if (!env.isTest()) ...` guards.
  if (!env.isTest()) {
    app.use(rateLimit({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.RATE_LIMIT_MAX,
      standardHeaders: true,
      legacyHeaders: false,
    }));
  }

  if (!env.isTest()) {
    app.use(morgan(env.isProd() ? 'combined' : 'dev', {
      stream: { write: (msg) => logger.info(msg.trim()) },
    }));
  }

  // Health — QA-10 P2: deep health now pings the DB so a wedged connection
  // pool shows up as unhealthy instead of "ok".
  app.get('/health', (_req, res) => res.json({ status: 'ok', env: env.NODE_ENV }));
  app.get(`${env.API_PREFIX}/health`, async (_req, res) => {
    let db = 'down';
    try {
      const { query } = require('./config/db');
      const r = await query('SELECT health_db_ping() AS now');
      db = r.rows[0]?.now ? 'ok' : 'down';
    } catch (_) { db = 'down'; }
    const status = db === 'ok' ? 'ok' : 'degraded';
    res.status(status === 'ok' ? 200 : 503).json({
      status, service: 'namastepos-api', version: env.APP_VERSION || require('../package.json').version,
      db, timestamp: new Date().toISOString(),
    });
  });

  // Public plan catalog
  app.get(`${env.API_PREFIX}/plans`, billingController.plans);

  // Public addon catalog
  app.use(`${env.API_PREFIX}/addons`, addonRoutes.publicRouter);

  // Guest QR ordering — PUBLIC (token in URL is auth)
  app.use(`${env.API_PREFIX}/guest`, guestRoutes);

  // Razorpay webhook — no auth, signature verified inside handler
  app.post(`${env.API_PREFIX}/webhooks/razorpay`, billingController.webhook);

  // Auth
  app.use(`${env.API_PREFIX}/auth`, authRoutes);
  app.use(`${env.API_PREFIX}/invitations`, invitationsRoutes);

  // DPDP — self-service (auth required, mounted inside the router)
  app.use(`${env.API_PREFIX}/me`, meRoutes);

  // DPDP — public (grievance officer lookup, complaint filing,
  // cookie/guest consent). NO auth — anyone can reach these.
  app.use(`${env.API_PREFIX}/compliance`, complianceRoutes);

  // Admin
  app.use(`${env.API_PREFIX}/admin`, adminRoutes);

  // Plan-tier feature gate — runs before each business-scoped router.
  // Returns 402 FEATURE_LOCKED when the business's tier doesn't include
  // the path's required feature. Open paths fall through.
  const featureGate = require('./middleware/featureGate');
  app.use(`${env.API_PREFIX}/businesses/:businessId`, featureGate());

  // Static /uploads — serves the files the upload route saves.
  // Mounted BEFORE the business-scoped routers so file fetches don't go
  // through the auth + feature-gate middleware (images are public URLs
  // baked into menu items / receipts / e-invoices).
  app.use('/uploads', express.static(require('path').join(__dirname, '..', 'uploads')));

  // Image uploads — accessible to any authenticated business owner/staff.
  // No feature gate (starter tier needs menu images too).
  const uploadsRoutes = require('./routes/uploads.routes');
  app.use(`${env.API_PREFIX}/businesses/:businessId/uploads`, uploadsRoutes);

  // Business-scoped
  app.use(`${env.API_PREFIX}/businesses/:businessId/menu`,     menuRoutes);
  app.use(`${env.API_PREFIX}/businesses/:businessId/orders`,   ordersRoutes);
  app.use(`${env.API_PREFIX}/businesses/:businessId/expenses`, expensesRoutes);
  app.use(`${env.API_PREFIX}/businesses/:businessId/reports`,  reportsRoutes);
  app.use(`${env.API_PREFIX}/businesses/:businessId/tax-invoices`, taxInvoicesRoutes);
  app.use(`${env.API_PREFIX}/businesses/:businessId/staff`,    staffRoutes);
  app.use(`${env.API_PREFIX}/businesses/:businessId/billing`,  billingRoutes);
  app.use(`${env.API_PREFIX}/businesses/:businessId/addons`,    addonRoutes.businessRouter);
  app.use(`${env.API_PREFIX}/businesses/:businessId/customers`, customersRoutes);
  app.use(`${env.API_PREFIX}/businesses/:businessId/ops`,        opsRoutes);
  app.use(`${env.API_PREFIX}/businesses/:businessId/ingredients`, ingredientsRoutes);
  app.use(`${env.API_PREFIX}/businesses/:businessId`,             sprint1ExtraRoutes);
  app.use(`${env.API_PREFIX}/businesses/:businessId`,             sprintsAllRoutes);
  app.use(`${env.API_PREFIX}/businesses/:businessId`,             finalSprintRoutes);
  app.use(`${env.API_PREFIX}/aggregator-webhooks`,                aggregatorWebhookRoutes);
  app.use(`${env.API_PREFIX}/wa-webhooks`,                        whatsappWebhookRoutes);
  app.use(`${env.API_PREFIX}/outlet-groups`,                      multiOutletRoutes);
  app.use(`${env.API_PREFIX}/site`,                               publicSiteRoutes);

  // Sentry error handler — captures 5xx before our JSON responder.
  sentry.installErrorHandler(app);

  // 404 + error handler — keep last
  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = buildApp;
