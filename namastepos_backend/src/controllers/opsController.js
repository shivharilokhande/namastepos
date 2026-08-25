// NamastePOS backend - KOT + tables endpoints

const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const kot = require('../services/kotService');
const tables = require('../services/tableService');
const qr = require('../services/qrService');

// ── KOT stations ───────────────────────────────────────────────────────
const stationBody = Joi.object({
  name: Joi.string().min(1).max(100).required(),
  printer_address: Joi.string().max(50).allow('', null),
  printer_paper_mm: Joi.number().integer().valid(58, 80).default(58),
  color: Joi.string().pattern(/^#[0-9A-Fa-f]{6}$/).allow(null, ''),
  is_active: Joi.boolean().default(true),
  display_order: Joi.number().integer().default(100),
});

// Fix (2026-08-23, review): strip inherited .default()s — a partial patch
// was resetting printer_paper_mm/is_active/display_order to defaults.
const stationPatch = stationBody.fork(['name'], (s) => s.optional()).min(1)
  .prefs({ noDefaults: true });
const ticketStatusBody = Joi.object({
  status: Joi.string().valid('pending', 'in_progress', 'done', 'cancelled').required(),
});

// Stations
const listStations = asyncHandler(async (req, res) => {
  res.json({ stations: await kot.listStations(req.params.businessId) });
});
const createStation = [
  validate({ body: stationBody }),
  asyncHandler(async (req, res) => {
    res.status(201).json({ station: await kot.createStation(req.params.businessId, req.body) });
  }),
];
const updateStation = [
  validate({ body: stationPatch }),
  asyncHandler(async (req, res) => {
    res.json({ station: await kot.updateStation(req.params.businessId, req.params.stationId, req.body) });
  }),
];
const deleteStation = asyncHandler(async (req, res) => {
  res.json(await kot.deleteStation(req.params.businessId, req.params.stationId));
});

// Tickets
const listTickets = asyncHandler(async (req, res) => {
  res.json({ tickets: await kot.listTickets(req.params.businessId, {
    stationId: req.query.stationId,
    status: req.query.status,
    day: req.query.day,
  })});
});
const updateTicketStatus = [
  validate({ body: ticketStatusBody }),
  asyncHandler(async (req, res) => {
    const t = await kot.updateTicketStatus(req.params.businessId, req.params.ticketId, req.body.status);
    res.json({ ticket: t });
  }),
];
const markTicketPrinted = asyncHandler(async (req, res) => {
  await kot.markPrinted(req.params.businessId, req.params.ticketId);
  res.json({ success: true });
});

// ── Floors & Tables ────────────────────────────────────────────────────
const floorBody = Joi.object({
  name: Joi.string().min(1).max(100).required(),
  display_order: Joi.number().integer().default(100),
});
const floorPatch = Joi.object({
  name: Joi.string().min(1).max(100),
  display_order: Joi.number().integer(),
}).min(1);

const tableBody = Joi.object({
  floorId: Joi.string().uuid().required(),
  label: Joi.string().min(1).max(20).required(),
  seats: Joi.number().integer().min(1).max(50).default(4),
  shape: Joi.string().valid('round', 'square', 'rectangle', 'booth').default('square'),
  xPos: Joi.number().integer().default(0),
  yPos: Joi.number().integer().default(0),
  // FF-252 — null lets the table inherit business default; explicit
  // dine_in / self_pickup wins over the business setting.
  serviceMode: Joi.string().valid('dine_in', 'self_pickup').allow(null),
});

// Patch body: camelCase to match the create schema + dashboard payloads.
// (Strict-mode Joi was rejecting `xPos` previously because only the
// snake_case names were listed, which broke the drag-to-arrange flow.)
const tablePatch = Joi.object({
  label: Joi.string().min(1).max(20),
  seats: Joi.number().integer().min(1).max(50),
  shape: Joi.string().valid('round', 'square', 'rectangle', 'booth'),
  xPos: Joi.number().integer(),
  yPos: Joi.number().integer(),
  floorId: Joi.string().uuid(),
  status: Joi.string().valid('available', 'occupied', 'reserved', 'cleaning', 'blocked'),
  floor_id: Joi.string().uuid(),
  serviceMode: Joi.string().valid('dine_in', 'self_pickup').allow(null),
}).min(1);

const openSessionBody = Joi.object({
  guestCount: Joi.number().integer().min(1).max(50).default(2),
  customerPhone: Joi.string().max(20).allow('', null),
  customerName: Joi.string().max(255).allow('', null),
  notes: Joi.string().max(500).allow('', null),
});

const listFloors = asyncHandler(async (req, res) => {
  res.json({ floors: await tables.listFloors(req.params.businessId) });
});
const createFloor = [
  validate({ body: floorBody }),
  asyncHandler(async (req, res) => {
    res.status(201).json({ floor: await tables.createFloor(req.params.businessId, req.body) });
  }),
];
const updateFloor = [
  validate({ body: floorPatch }),
  asyncHandler(async (req, res) => {
    res.json({ floor: await tables.updateFloor(req.params.businessId, req.params.floorId, req.body) });
  }),
];
const deleteFloor = asyncHandler(async (req, res) => {
  res.json(await tables.deleteFloor(req.params.businessId, req.params.floorId));
});

const listTables = asyncHandler(async (req, res) => {
  res.json({ tables: await tables.listTables(req.params.businessId, { floorId: req.query.floorId }) });
});
const createTable = [
  validate({ body: tableBody }),
  asyncHandler(async (req, res) => {
    res.status(201).json({ table: await tables.createTable(req.params.businessId, req.body) });
  }),
];
const updateTable = [
  validate({ body: tablePatch }),
  asyncHandler(async (req, res) => {
    res.json({ table: await tables.updateTable(req.params.businessId, req.params.tableId, req.body) });
  }),
];
const deleteTable = asyncHandler(async (req, res) => {
  res.json(await tables.deleteTable(req.params.businessId, req.params.tableId));
});

const openSession = [
  validate({ body: openSessionBody }),
  asyncHandler(async (req, res) => {
    const session = await tables.openSession(
      req.params.businessId, req.params.tableId, req.body, req.user.id);
    res.status(201).json({ session });
  }),
];

const closeSession = [
  validate({ body: Joi.object({
    paymentMethod: Joi.string().valid('cash', 'upi', 'card', 'online').default('cash'),
    // Settle-time discount in rupees (2026-08-22). Capped server-side.
    discountInr: Joi.number().min(0).default(0),
    // 2026-08-25 split payments: 1-3 legs; service enforces that they sum
    // to (session total − shortfall) within ₹0.01, else 400.
    paymentBreakdown: Joi.array().items(Joi.object({
      method: Joi.string().valid('cash', 'upi', 'card', 'online', 'wallet').required(),
      amountInr: Joi.number().positive().required(),
    })).min(1).max(3).allow(null),
    // 2026-08-25 shortfall: customer underpaid this much — booked as a
    // negative wallet movement (debt) on the identified customer.
    shortfallInr: Joi.number().min(0).default(0),
  })}),
  asyncHandler(async (req, res) => {
    const session = await tables.closeSession(
      req.params.businessId, req.params.sessionId, req.user.id,
      req.body.paymentMethod || 'cash', req.body.discountInr || 0,
      req.body.paymentBreakdown || null, req.body.shortfallInr || 0);
    res.json({ session });
  }),
];

const sessionDetail = asyncHandler(async (req, res) => {
  res.json({ session: await tables.sessionDetail(req.params.businessId, req.params.sessionId) });
});

// Release a table whose customer left without ordering. Refuses if any
// non-cancelled orders are attached — use closeSession (Settle) instead.
const abandonSession = asyncHandler(async (req, res) => {
  const session = await tables.abandonSession(
    req.params.businessId, req.params.sessionId, req.user.id);
  res.json({ session });
});

// ── QR settings + per-table token ──────────────────────────────────────
const qrSettings = asyncHandler(async (req, res) => {
  res.json({ settings: await qr.getSettings(req.params.businessId) });
});

const qrSettingsUpdate = asyncHandler(async (req, res) => {
  res.json({ settings: await qr.updateSettings(req.params.businessId, req.body) });
});

const qrTokenForTable = asyncHandler(async (req, res) => {
  const token = await qr.issueTokenForTable(req.params.businessId, req.params.tableId);
  res.json({ token });
});

const qrRotateToken = asyncHandler(async (req, res) => {
  const token = await qr.rotateToken(req.params.businessId, req.params.tableId);
  res.json({ token });
});

module.exports = {
  // Stations
  listStations, createStation, updateStation, deleteStation,
  listTickets, updateTicketStatus, markTicketPrinted,
  // Tables
  listFloors, createFloor, updateFloor, deleteFloor,
  listTables, createTable, updateTable, deleteTable,
  openSession, closeSession, abandonSession, sessionDetail,
  // QR
  qrSettings, qrSettingsUpdate, qrTokenForTable, qrRotateToken,
};
