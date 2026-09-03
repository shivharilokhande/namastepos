// Aggregate routes for Sprints 2-10. Mounted under /v1/businesses/:businessId.
//
// NP-145 (2026-09-03): this file was a ~1000-line grab-bag. The routes now
// live in six domain files (pure moves — same paths, same middleware order,
// same handlers); this file stays as a thin aggregator so the app.js mount
// (`app.use('/v1/businesses/:businessId', sprintsAllRoutes)`) is unchanged.
//
// Auth is applied ONCE here, exactly as before the split — the domain routers
// deliberately carry no requireAuth/requireBusinessOwnership of their own
// (applying it per sub-router would run the ownership DB check up to six
// times per request). Do not mount the domain files anywhere else.
//
// Split map (old section → new file):
//   payments.routes.js          — order refund (FF-304), /refunds list,
//                                 gift cards + wallet (FF-1005), discount
//                                 approvals, tips, dual-ledger 410 tombstones
//   reportsCompliance.routes.js — action center (FF-244), /reports/* (NPS,
//                                 menu engineering, leakage), GSTR CSVs
//                                 (FF-314), e-way bills (FF-1103), Tally/Zoho
//                                 exports + e-invoice, /accounting/eway-bills
//   delivery.routes.js          — aggregator credentials/mapping + OTP link,
//                                 delivery zones (FF-331), drivers +
//                                 assignments
//   operations.routes.js        — device tokens (FF-330), shifts + payroll
//                                 (FF-332), daily closings, wastage,
//                                 reservations + wait list, customer history,
//                                 printers + print jobs, /imports/* CSV hub
//   growth.routes.js            — referral (FF-333), promo (FF-329), feature
//                                 overrides (FF-315), memberships, /site,
//                                 WhatsApp campaigns
//   retail.routes.js            — /retail/* (SKUs, vendors, POs, ledger,
//                                 cheques, quotations, warehouses)

const express = require('express');
const { requireAuth, requireBusinessOwnership } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });
router.use(requireAuth, requireBusinessOwnership);

router.use(require('./payments.routes'));
router.use(require('./reportsCompliance.routes'));
router.use(require('./delivery.routes'));
router.use(require('./operations.routes'));
router.use(require('./growth.routes'));
router.use(require('./retail.routes'));

module.exports = router;
