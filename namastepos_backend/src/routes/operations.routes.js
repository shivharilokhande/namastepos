// Restaurant operations — device tokens, staff shifts + payroll, daily
// closings, wastage, reservations + wait list, customer history, printers +
// print jobs, and the CSV bulk-import hub.
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

const dailyClosing = require('../services/dailyClosingService');
const wastage = require('../services/wastageService');
const reservation = require('../services/reservationService');
const customerHistory = require('../services/customerHistoryService');
const printer = require('../services/printerService');
const push = require('../services/pushService');
const shifts = require('../services/staffShiftService');

const router = express.Router({ mergeParams: true });

// ── FF-330 device tokens (mobile registers on cold start) ──────────────
router.post('/device-tokens',
  validate({ body: Joi.object({
    token: Joi.string().required(),
    platform: Joi.string().valid('android', 'ios', 'web').default('android'),
  })}),
  asyncHandler(async (req, res) => {
    await push.registerToken(req.user.id, req.params.businessId, req.body);
    res.json({ ok: true });
  }));

// ── FF-332 staff shifts + payroll ──────────────────────────────────────
router.post('/shifts/clock-in',
  asyncHandler(async (req, res) =>
    res.json(await shifts.clockIn(req.params.businessId, req.user.id))));
router.post('/shifts/clock-out',
  asyncHandler(async (req, res) =>
    res.json(await shifts.clockOut(req.params.businessId, req.user.id))));
router.get('/shifts/mine',
  asyncHandler(async (req, res) =>
    res.json({ shift: await shifts.myOpenShift(req.params.businessId, req.user.id) })));
router.get('/shifts',
  requireRole(['business_owner', 'staff_manager']),
  asyncHandler(async (req, res) =>
    res.json({ shifts: await shifts.listForBusiness(
      req.params.businessId, req.query
    )})));
router.get('/shifts/payroll.csv',
  requireRole(['business_owner']),
  asyncHandler(async (req, res) => {
    const csv = await shifts.payrollCsv(req.params.businessId, req.query.month);
    res.type('text/csv').attachment(`payroll-${req.query.month}.csv`).send(csv);
  }));

// ── Daily closing / Z-report ─────────────────────────────────────────────
router.get ('/daily-closings/preview',
  asyncHandler(async (req, res) =>
    res.json({ preview: await dailyClosing.preview(req.params.businessId, req.query.date) })
  )
);
router.get ('/daily-closings', asyncHandler(async (req, res) =>
  res.json({ closings: await dailyClosing.list(req.params.businessId) })));
router.post('/daily-closings',
  requireRole(['business_owner','staff_manager']),
  validate({ body: Joi.object({
    date: Joi.date().iso().required(),
    cashCounted: Joi.number().integer().min(0).required(),
    notes: Joi.string().max(2000).allow('', null),
    signature: Joi.string().max(255).allow('', null),
  })}),
  asyncHandler(async (req, res) =>
    res.status(201).json({ closing: await dailyClosing.close(req.params.businessId, {
      ...req.body, closedByUserId: req.user?.id,
    })})
  )
);
router.post('/daily-closings/:date/reopen',
  requireRole(['business_owner']),
  asyncHandler(async (req, res) => {
    await dailyClosing.reopen(req.params.businessId, req.params.date);
    res.json({ success: true });
  })
);

// ── Wastage ──────────────────────────────────────────────────────────────
router.get ('/wastage', asyncHandler(async (req, res) =>
  res.json({ report: await wastage.report(req.params.businessId, req.query) })));
router.post('/wastage',
  // 2026-08-25 (founder): dish wastage — "prepared 20 plates, sold 17" →
  // log the 3 unsold plates against the MENU ITEM. Either ingredientId or
  // menuItemId must be set (service enforces; Joi can't cleanly express
  // "at least one non-null" with allow(null)). New reason 'extra_prepared'
  // for exactly that case. costPaise is optional for dishes — the service
  // values plates at recipe cost when omitted.
  validate({ body: Joi.object({
    ingredientId: Joi.string().uuid().allow(null),
    menuItemId: Joi.string().uuid().allow(null),
    qty: Joi.number().positive().required(),
    unit: Joi.string().max(20).allow('', null),
    costPaise: Joi.number().integer().min(0),
    reason: Joi.string().valid('expired','spilled','over_prep','extra_prepared','damaged','other').required(),
    note: Joi.string().max(500).allow('', null),
  })}),
  asyncHandler(async (req, res) =>
    res.status(201).json({ entry: await wastage.log(req.params.businessId, req.body, req.user?.id) })
  )
);

// ── Reservations + wait list ─────────────────────────────────────────────
router.get ('/reservations', asyncHandler(async (req, res) =>
  res.json({ reservations: await reservation.list(req.params.businessId, req.query) })));
router.post('/reservations',
  validate({ body: Joi.object({
    customerName: Joi.string().min(1).max(255).required(),
    customerPhone: Joi.string().min(7).max(20).required(),
    customerEmail: Joi.string().email().allow('', null),
    partySize: Joi.number().integer().min(1).max(50).required(),
    // Founder bug #11 (2026-08-25): reservations could be booked in the
    // past or years ahead. Enforced via .custom() so "now" is computed at
    // REQUEST time — a module-load-time `new Date()` would freeze the
    // boundary at server boot and rot as the process stays up.
    reservedAt: Joi.date().iso().required().custom((value, helpers) => {
      const now = Date.now();
      const t = value.getTime();
      if (t < now) {
        return helpers.message('Reservation time must be in the future');
      }
      if (t > now + 90 * 24 * 60 * 60 * 1000) {
        return helpers.message('Reservations can be made at most 90 days ahead');
      }
      return value;
    }),
    durationMin: Joi.number().integer().min(15).max(360).default(90),
    tableId: Joi.string().uuid().allow(null),
    specialRequests: Joi.string().max(1000).allow('', null),
    source: Joi.string().max(40).default('phone'),
  })}),
  asyncHandler(async (req, res) =>
    res.status(201).json({ reservation: await reservation.create(req.params.businessId, req.body, req.user?.id) })
  )
);
router.put ('/reservations/:id', asyncHandler(async (req, res) =>
  res.json({ reservation: await reservation.update(req.params.businessId, req.params.id, req.body) })));
router.post('/reservations/:id/seat', asyncHandler(async (req, res) =>
  res.json({ reservation: await reservation.seat(req.params.businessId, req.params.id) })));
router.get ('/wait-list', asyncHandler(async (req, res) =>
  res.json({ entries: await reservation.listWaitList(req.params.businessId) })));
router.post('/wait-list',
  validate({ body: Joi.object({
    customerName: Joi.string().required(), customerPhone: Joi.string().required(),
    partySize: Joi.number().integer().positive().required(),
    estimatedWaitMin: Joi.number().integer().min(0),
  })}),
  asyncHandler(async (req, res) =>
    res.status(201).json({ entry: await reservation.addToWaitList(req.params.businessId, req.body) })
  )
);

// ── Customer history ─────────────────────────────────────────────────────
router.get ('/customer-history/:phone', asyncHandler(async (req, res) => {
  const profile = await customerHistory.profileForCashier(req.params.businessId, req.params.phone);
  if (!profile) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json(profile);
}));
router.get ('/customers/:id/reorder-last', asyncHandler(async (req, res) => {
  const items = await customerHistory.reorderSameAsLast(req.params.businessId, req.params.id);
  res.json({ items });
}));

// ── Printer + KDS ────────────────────────────────────────────────────────
router.get ('/printers', asyncHandler(async (req, res) =>
  res.json({ printers: await printer.listPrinters(req.params.businessId) })));
router.put ('/printers',
  requireRole(['business_owner','staff_manager']),
  validate({ body: Joi.object({
    id: Joi.string().uuid().allow(null),
    name: Joi.string().required(),
    kind: Joi.string().valid('bill','kot').required(),
    connection: Joi.string().valid('bluetooth','wifi','usb','network').required(),
    address: Joi.string().max(120).allow('', null),
    paperWidthMm: Joi.number().valid(58, 80),
    stationId: Joi.string().uuid().allow(null),
    isDefault: Joi.boolean(),
  })}),
  asyncHandler(async (req, res) =>
    res.json({ printer: await printer.upsertPrinter(req.params.businessId, req.body) })
  )
);
router.delete('/printers/:id',
  requireRole(['business_owner']),
  asyncHandler(async (req, res) => {
    await printer.deletePrinter(req.params.businessId, req.params.id);
    res.json({ success: true });
  })
);
router.get ('/print-jobs/next', asyncHandler(async (req, res) =>
  res.json({ job: await printer.dequeueNext(req.params.businessId) })));
router.post('/print-jobs/:id/done',
  validate({ body: Joi.object({ ok: Joi.boolean().required(), errorMessage: Joi.string().allow('', null) })}),
  asyncHandler(async (req, res) => {
    await printer.markJobDone(req.params.businessId, req.params.id, req.body.ok, req.body.errorMessage);
    res.json({ success: true });
  })
);

// ── Bulk-import hub (Founder request 2026-08-25) ────────────────────────
// CSV imports for ingredients, ingredient purchases, and expenses. The
// dashboard parses the CSV client-side (same minimal parser as the menu
// dialog) and POSTs a JSON `rows` array; each row is re-validated here with
// Joi because these endpoints are also reachable directly via the API.
//
// Path naming is deliberate (2026-08-25): featureGate matches substrings,
// and '/bulk-import' maps to the enterprise-only `bulk_import` key (that
// gate is meant for the retail SKU import). We mount under '/imports/…'
// instead so:
//   /imports/ingredients[…]  → matches the '/ingredients' rule →
//                              recipe_costing (Pro), same plan tier as the
//                              rest of the ingredients module;
//   /imports/expenses        → ungated, like the single-expense routes.
// No new tables — rows land in the existing ingredients /
// ingredient_transactions / expenses tables via the existing services.
const ingredientSvc = require('../services/ingredientService');
const expenseSvc = require('../services/expenseService');

const importRowsBody = Joi.object({
  rows: Joi.array().items(Joi.object().unknown(true)).min(1).max(1000).required(),
});

// Mirrors ingredientController.ingredientBody — keep the two in sync.
const ingredientRowSchema = Joi.object({
  name: Joi.string().min(1).max(255).required(),
  category: Joi.string().max(50).allow('', null),
  unit: Joi.string().valid('g', 'kg', 'ml', 'l', 'piece', 'pack', 'dozen').default('g'),
  stock: Joi.number().min(0).default(0),
  reorderLevel: Joi.number().min(0).default(0),
  costPerUnitInr: Joi.number().min(0).default(0),
  vendor: Joi.string().max(255).allow('', null),
  vendorPhone: Joi.string().max(20).allow('', null),
  notes: Joi.string().max(500).allow('', null),
});

// Mirrors ingredientController.purchaseBody, plus `ingredient` (name lookup —
// CSV authors know names, not UUIDs).
const purchaseRowSchema = Joi.object({
  ingredient: Joi.string().min(1).max(255).required(),
  qty: Joi.number().positive().required(),
  unitCostInr: Joi.number().min(0),
  totalCostInr: Joi.number().min(0),
  vendor: Joi.string().max(255).allow('', null),
  note: Joi.string().max(500).allow('', null),
}).or('unitCostInr', 'totalCostInr');

// Mirrors expenseController.createBody (categories = expense_category enum,
// migrations 001/055/058) — keep in sync when the enum grows.
const expenseRowSchema = Joi.object({
  date: Joi.date().iso().required(),
  category: Joi.string().valid(
    'ingredients', 'fuel', 'labor', 'rent', 'utilities',
    'packaging', 'marketing', 'maintenance',
    'chef_salary', 'helper_salary', 'staff_salary', 'gas', 'electricity',
    'water', 'transport', 'equipment', 'cleaning', 'license_fees',
    'other'
  ).default('other'),
  amount: Joi.number().positive().precision(2).required(),
  description: Joi.string().max(500).allow('', null),
});

/**
 * Runs `handler` for each row, collecting a per-row report. Row numbers are
 * 1-based CSV *file* lines (data starts at line 2, after the header) so the
 * error table matches what the user sees in Excel/Sheets.
 *
 * Migration wizard (2026-09-03): handlers may now return
 *   { skipped: true, warning }  — row was an idempotent no-op (e.g. a
 *                                 sales day already imported); NOT counted
 *                                 as imported, reported under `warnings`.
 *   { warnings: [string] }      — row imported, with non-fatal notes (e.g.
 *                                 opening balances skipped on a re-run).
 * The response gains a `warnings: [{ row, warning }]` array — additive, so
 * existing callers of { imported, failed } are unaffected.
 */
async function runImport(rows, schema, handler) {
  let imported = 0;
  const failed = [];
  const warnings = [];
  for (let i = 0; i < rows.length; i++) {
    const rowNo = i + 2;
    // stripUnknown: CSVs often carry extra columns (totals, remarks) — drop
    // them instead of failing the whole row.
    const { value, error } = schema.validate(rows[i], { stripUnknown: true });
    if (error) { failed.push({ row: rowNo, error: error.message }); continue; }
    try {
      const out = await handler(value);
      if (out && out.skipped) {
        warnings.push({ row: rowNo, warning: out.warning || 'Skipped' });
        continue;
      }
      if (out && Array.isArray(out.warnings)) {
        for (const w of out.warnings) warnings.push({ row: rowNo, warning: w });
      }
      imported++;
    } catch (err) {
      // Service errors (Conflict on duplicate name, NotFound, …) become
      // per-row failures — one bad row must not abort the batch.
      failed.push({ row: rowNo, error: err.message || 'Import failed' });
    }
  }
  return { imported, failed, warnings };
}

router.post('/imports/ingredients',
  requireRole(['business_owner', 'staff_manager']),
  validate({ body: importRowsBody }),
  asyncHandler(async (req, res) => {
    const result = await runImport(req.body.rows, ingredientRowSchema, (row) =>
      ingredientSvc.create(req.params.businessId, row));
    res.json(result);
  })
);

// Purchases = goods received against existing ingredients. Reuses
// recordPurchase so stock + weighted-average cost + the
// ingredient_transactions audit log all update exactly like a manual entry.
// (The retail purchase_orders/goods_receipts tables are a multi-step
// PO→GRN flow scoped to retail SKUs — not a fit for a flat CSV.)
router.post('/imports/ingredients/purchases',
  requireRole(['business_owner', 'staff_manager']),
  validate({ body: importRowsBody }),
  asyncHandler(async (req, res) => {
    // One name→id lookup up front instead of a query per row.
    const existing = await ingredientSvc.list(req.params.businessId, { onlyActive: true });
    const byName = new Map(existing.map((i) => [i.name.trim().toLowerCase(), i.id]));
    const result = await runImport(req.body.rows, purchaseRowSchema, async (row) => {
      const id = byName.get(row.ingredient.trim().toLowerCase());
      if (!id) throw new Error(`Ingredient "${row.ingredient}" not found — import it on the Ingredients tab first`);
      const { ingredient: _name, ...purchase } = row;
      await ingredientSvc.recordPurchase(req.params.businessId, id, purchase);
    });
    res.json(result);
  })
);

router.post('/imports/expenses',
  requireRole(['business_owner', 'staff_manager']),
  validate({ body: importRowsBody }),
  asyncHandler(async (req, res) => {
    const result = await runImport(req.body.rows, expenseRowSchema, (row) =>
      expenseSvc.create(req.params.businessId, row));
    res.json(result);
  })
);

// ── "Switch to NamastePOS" migration imports (2026-09-03) ───────────────
// Customers (+ opening loyalty/wallet balances) and aggregate sales history
// exported from a previous POS. Ungated (like /imports/expenses — neither
// path matches a featureGate rule) because migration is the very first
// thing a switcher does, before they've picked a plan tier. Idempotency
// mechanics live in migrationImportService — see the header there.
const migrationSvc = require('../services/migrationImportService');

const customerImportRowSchema = Joi.object({
  phone: Joi.string().pattern(/^[0-9]{10}$/).required()
    .messages({ 'string.pattern.base': 'phone must be a 10-digit mobile number' }),
  name: Joi.string().max(255).allow('', null),
  email: Joi.string().email().allow('', null),
  tags: Joi.string().max(500).allow('', null),          // comma/;/| separated
  whatsappOptIn: Joi.boolean()
    .truthy('yes', 'y', 'Y', 'Yes', 'YES', '1')
    .falsy('no', 'n', 'N', 'No', 'NO', '0'),
  loyaltyPoints: Joi.number().integer().min(0),
  walletBalanceInr: Joi.number().min(0),
  notes: Joi.string().max(1000).allow('', null),
});

router.post('/imports/customers',
  requireRole(['business_owner', 'staff_manager']),
  validate({ body: importRowsBody }),
  asyncHandler(async (req, res) => {
    const result = await runImport(req.body.rows, customerImportRowSchema, (row) =>
      migrationSvc.importCustomerRow(req.params.businessId, row));
    res.json(result);
  })
);

// Date is a plain YYYY-MM-DD string (not Joi.date()) so there's no timezone
// re-interpretation — the service pins it to noon IST and enforces past-only.
const salesHistoryRowSchema = Joi.object({
  date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required()
    .messages({ 'string.pattern.base': 'date must be YYYY-MM-DD' }),
  orders: Joi.number().integer().min(1).required(),
  grossInr: Joi.number().min(0).required(),
  discountInr: Joi.number().min(0),
  taxInr: Joi.number().min(0),
});

// Cap 1100 rows (3 years of daily aggregates) instead of the usual 1000.
const salesHistoryBody = Joi.object({
  rows: Joi.array().items(Joi.object().unknown(true)).min(1).max(1100).required(),
});

router.post('/imports/sales-history',
  requireRole(['business_owner', 'staff_manager']),
  validate({ body: salesHistoryBody }),
  asyncHandler(async (req, res) => {
    const result = await runImport(req.body.rows, salesHistoryRowSchema, (row) =>
      migrationSvc.importSalesRow(req.params.businessId, row));
    res.json(result);
  })
);

module.exports = router;
