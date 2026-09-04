// Retail mode — SKUs, barcodes, vendors, purchase orders, party ledger,
// cheques, quotations and warehouses.
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

const retail = require('../services/retailService');

const router = express.Router({ mergeParams: true });

// ── Retail (mounted under same business path) ───────────────────────────
router.get('/retail/items', asyncHandler(async (req, res) => res.json({ items: await retail.listItems(req.params.businessId, req.query) })));
router.post(
  '/retail/items',
  requireRole(['business_owner', 'staff_manager']),
  validate({ body: Joi.object({
    name: Joi.string().required(),
    category: Joi.string().allow('', null),
    unit: Joi.string().default('piece'),
    hsnCode: Joi.string().allow('', null),
    gstPct: Joi.number().valid(0, 5, 12, 18, 28).default(18),
    mrpPaise: Joi.number().integer().allow(null),
    priceInr: Joi.number().required(),
    costPaise: Joi.number().integer().allow(null),
    stock: Joi.number().default(0),
    reorderLevel: Joi.number().default(0),
  }) }),
  asyncHandler(async (req, res) => res.status(201).json({ item: await retail.createItem(req.params.businessId, req.body) })),
);
router.post(
  '/retail/items/:id/barcodes',
  validate({ body: Joi.object({ barcode: Joi.string().required(), isPrimary: Joi.boolean().default(false) }) }),
  asyncHandler(async (req, res) => {
    await retail.addBarcode(req.params.businessId, req.params.id, req.body.barcode, req.body.isPrimary);
    res.status(201).json({ success: true });
  }),
);
router.get('/retail/barcode/:barcode', asyncHandler(async (req, res) => {
  const it = await retail.findByBarcode(req.params.businessId, req.params.barcode);
  if (!it) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ item: it });
}));
router.post(
  '/retail/bulk-import',
  requireRole(['business_owner']),
  validate({ body: Joi.object({ rows: Joi.array().items(Joi.object().unknown(true)).max(1000).required() }) }),
  asyncHandler(async (req, res) => res.json(await retail.bulkImport(req.params.businessId, req.body.rows))),
);
router.get('/retail/vendors', requireRole(['business_owner', 'staff_manager']), asyncHandler(async (req, res) => res.json({ vendors: await retail.listVendors(req.params.businessId) })));
router.post(
  '/retail/vendors',
  requireRole(['business_owner', 'staff_manager']),
  asyncHandler(async (req, res) => res.status(201).json({ vendor: await retail.createVendor(req.params.businessId, req.body) })),
);
router.post(
  '/retail/purchase-orders',
  requireRole(['business_owner', 'staff_manager']),
  asyncHandler(async (req, res) => res.status(201).json({ po: await retail.createPO(req.params.businessId, req.body, req.user?.id) })),
);
router.post(
  '/retail/purchase-orders/:poId/receive',
  requireRole(['business_owner', 'staff_manager']),
  asyncHandler(async (req, res) => res.status(201).json({ grn: await retail.receivePO(req.params.businessId, req.params.poId, req.body, req.user?.id) })),
);
router.post(
  '/retail/ledger',
  requireRole(['business_owner', 'staff_manager']),
  asyncHandler(async (req, res) => res.status(201).json({ entry: await retail.postLedger(req.params.businessId, req.body) })),
);
router.get('/retail/ledger/:partyKind/:partyId', asyncHandler(async (req, res) => res.json({ entries: await retail.partyLedger(req.params.businessId, req.params.partyKind, req.params.partyId) })));
router.post(
  '/retail/cheques',
  asyncHandler(async (req, res) => res.status(201).json({ cheque: await retail.recordCheque(req.params.businessId, req.body) })),
);
router.put(
  '/retail/cheques/:id/status',
  validate({ body: Joi.object({
    status: Joi.string().valid('pending', 'cleared', 'bounced', 'cancelled').required(),
    clearedOn: Joi.date().iso().allow(null),
  }) }),
  asyncHandler(async (req, res) => res.json({ cheque: await retail.updateChequeStatus(req.params.businessId, req.params.id, req.body.status, req.body.clearedOn) })),
);
router.post(
  '/retail/quotations',
  asyncHandler(async (req, res) => res.status(201).json({ quotation: await retail.createQuotation(req.params.businessId, req.body) })),
);
router.post(
  '/retail/warehouses',
  requireRole(['business_owner']),
  asyncHandler(async (req, res) => res.status(201).json({ warehouse: await retail.createWarehouse(req.params.businessId, req.body) })),
);

module.exports = router;
