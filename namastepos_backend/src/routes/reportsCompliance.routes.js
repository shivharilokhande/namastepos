// Owner reports & tax/accounting compliance — action center, NPS / menu
// engineering / leakage reports, GSTR CSVs, e-way bills, accounting exports
// and e-invoicing.
//
// NP-145 (2026-09-03): split out of sprintsAll.routes.js. Pure move — same
// paths, same middleware order, same handlers. Mounted by sprintsAll.routes.js
// under /v1/businesses/:businessId AFTER requireAuth + requireBusinessOwnership
// — do not mount this router directly.

const express = require('express');
const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const { requireRole } = require('../middleware/auth');

const actionCenter = require('../services/actionCenterService');
const leakage = require('../services/revenueLeakageService');
const nps = require('../services/npsService');
const menuEng = require('../services/menuEngineeringService');
const eway = require('../services/ewayBillService');
const gstr = require('../services/gstrExportService');
const accountingExport = require('../services/accountingExportService');

const router = express.Router({ mergeParams: true });

// ── Action Center (FF-244) ─────────────────────────────────────────────
router.get('/action-center',
  asyncHandler(async (req, res) =>
    res.json(await actionCenter.fetch(req.params.businessId))));

// ── FF-1002 NPS ─────────────────────────────────────────────────────────
router.get('/reports/nps',
  asyncHandler(async (req, res) =>
    res.json(await nps.summary(req.params.businessId,
      parseInt(req.query.days, 10) || 30))));

// ── FF-1106 Menu engineering ────────────────────────────────────────────
router.get('/reports/menu-engineering',
  asyncHandler(async (req, res) =>
    res.json(await menuEng.classify(req.params.businessId,
      req.query.from, req.query.to))));

// ── FF-1103 E-way bill ──────────────────────────────────────────────────
router.get('/eway-bills',
  asyncHandler(async (req, res) =>
    res.json({ bills: await eway.list(req.params.businessId) })));
router.post('/eway-bills',
  requireRole(['business_owner']),
  validate({ body: Joi.object({
    taxInvoiceId: Joi.string().uuid().allow(null),
    fromPincode: Joi.string().length(6).required(),
    toPincode:   Joi.string().length(6).required(),
    fromState: Joi.string().max(50).required(),
    toState:   Joi.string().max(50).required(),
    distanceKm: Joi.number().integer().min(1).max(4000).allow(null),
    vehicleNo: Joi.string().max(20).allow('', null),
    transporterId: Joi.string().max(30).allow('', null),
  })}),
  asyncHandler(async (req, res) =>
    res.status(201).json(await eway.generate(req.params.businessId, req.body))));
router.post('/eway-bills/:id/cancel',
  requireRole(['business_owner']),
  asyncHandler(async (req, res) =>
    res.json(await eway.cancel(req.params.businessId, req.params.id, req.body.reason))));

// ── FF-314 GSTR-1 / GSTR-3B CSV ─────────────────────────────────────────
router.get('/reports/gstr1.csv',
  asyncHandler(async (req, res) => {
    const csv = await gstr.gstr1(req.params.businessId, req.query.from, req.query.to);
    res.type('text/csv').attachment(`gstr1-${req.query.from}-to-${req.query.to}.csv`).send(csv);
  }));
router.get('/reports/gstr3b.csv',
  asyncHandler(async (req, res) => {
    const csv = await gstr.gstr3b(req.params.businessId, req.query.from, req.query.to);
    res.type('text/csv').attachment(`gstr3b-${req.query.from}-to-${req.query.to}.csv`).send(csv);
  }));

// ── Revenue leakage (FF-246) ───────────────────────────────────────────
router.get('/reports/leakage',
  requireRole(['business_owner', 'staff_manager']),
  asyncHandler(async (req, res) =>
    res.json(await leakage.summary(
      req.params.businessId,
      req.query.from, req.query.to,
    ))));

// ── Accounting export + e-invoice ────────────────────────────────────────
router.post('/exports/tally',
  validate({ body: Joi.object({ startDate: Joi.date().iso().required(), endDate: Joi.date().iso().required() })}),
  asyncHandler(async (req, res) => {
    const r = await accountingExport.tallyExport(req.params.businessId, req.body);
    res.set('Content-Type', 'application/xml').send(r.xml);
  })
);
router.post('/exports/zoho',
  validate({ body: Joi.object({ startDate: Joi.date().iso().required(), endDate: Joi.date().iso().required() })}),
  asyncHandler(async (req, res) => {
    const csv = await accountingExport.zohoCsv(req.params.businessId, req.body);
    res.set('Content-Type', 'text/csv').send(csv);
  })
);
router.get ('/exports', asyncHandler(async (req, res) =>
  res.json({ exports: await accountingExport.listExports(req.params.businessId) })));
// WHY (2026-08-25): the POST below stores the IRN in einvoice_irns but
// nothing ever read it back — the founder saw "IRN generated · 580ce2…"
// and the IRN then vanished. Read-only list (same ungated GET shape as
// /exports above) so Orders + Tax Invoices pages can badge e-invoiced rows.
router.get ('/einvoice', asyncHandler(async (req, res) =>
  res.json({ irns: await accountingExport.listIrns(req.params.businessId) })));
router.post('/einvoice/:orderId',
  requireRole(['business_owner','staff_manager']),
  asyncHandler(async (req, res) =>
    res.status(201).json({ irn: await accountingExport.generateIrn(req.params.businessId, req.params.orderId) })
  )
);
// FF-402 code-review pass — namespaced under `/accounting/` to avoid
// colliding with FF-1103 `/eway-bills` above (which uses the dedicated
// `eway` service with a different validator). This variant is the
// accounting-export flavour used by the Tally / GSTR pipeline.
router.post('/accounting/eway-bills',
  validate({ body: Joi.object({
    invoiceId: Joi.string().uuid().required(),
    vehicleNo: Joi.string().required(),
    distanceKm: Joi.number().integer().min(0).required(),
  })}),
  asyncHandler(async (req, res) =>
    res.status(201).json({ ewayBill: await accountingExport.generateEwayBill(req.params.businessId, req.body.invoiceId, req.body) })
  )
);

module.exports = router;
