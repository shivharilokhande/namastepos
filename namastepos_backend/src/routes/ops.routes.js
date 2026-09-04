// NamastePOS backend - KOT + tables routes (mounted at /businesses/:businessId/ops)

const express = require('express');
const c = require('../controllers/opsController');
const { requireAuth, requireBusinessOwnership, requireRole } = require('../middleware/auth');
const sub = require('../services/subscriptionService');

const router = express.Router({ mergeParams: true });
router.use(requireAuth, requireBusinessOwnership);

// ── KOT stations ──────────────────────────────────────────────────────
router.get('/kot/stations', c.listStations);
router.post('/kot/stations', requireRole(['business_owner']), ...c.createStation);
router.put('/kot/stations/:stationId', requireRole(['business_owner']), ...c.updateStation);
router.delete('/kot/stations/:stationId', requireRole(['business_owner']), c.deleteStation);

// ── KOT tickets (live queue) ───────────────────────────────────────────
router.get('/kot/tickets', c.listTickets);
router.put('/kot/tickets/:ticketId/status', ...c.updateTicketStatus);
router.post('/kot/tickets/:ticketId/printed', c.markTicketPrinted);

// ── Floors ────────────────────────────────────────────────────────────
// Push 16d — plan-gated floor creation. enforceLimit('floors') reads
// plan.limits.floors and 402s when the count would exceed it.
router.get('/floors', c.listFloors);
router.post(
  '/floors',
  requireRole(['business_owner', 'staff_manager']),
  sub.enforceLimit('floors'),
  ...c.createFloor,
);
router.put('/floors/:floorId', requireRole(['business_owner', 'staff_manager']), ...c.updateFloor);
router.delete('/floors/:floorId', requireRole(['business_owner']), c.deleteFloor);

// ── Tables ────────────────────────────────────────────────────────────
// Push 16d — plan-gated table creation.
router.get('/tables', c.listTables);
router.post(
  '/tables',
  requireRole(['business_owner', 'staff_manager']),
  sub.enforceLimit('tables'),
  ...c.createTable,
);
router.put('/tables/:tableId', requireRole(['business_owner', 'staff_manager']), ...c.updateTable);
router.delete('/tables/:tableId', requireRole(['business_owner']), c.deleteTable);

// ── Sessions (seat / close) ──────────────────────────────────────────
router.post('/tables/:tableId/sessions', ...c.openSession);
router.get('/sessions/:sessionId', c.sessionDetail);
// 2026-08-25 (security review finding #5): settle moves money (discounts,
// wallet debits, shortfall debt on a customer) — it must not be open to
// every authenticated staff role. Gated to owner + manager, matching the
// other money-touching routes (floors/tables CRUD here, expenses/settle
// flows in sprintsAll.routes; order refunds are owner-only).
router.post(
  '/sessions/:sessionId/close',
  requireRole(['business_owner', 'staff_manager']),
  ...c.closeSession,
);
// Push 22 — release a table whose customer left without ordering.
router.post('/sessions/:sessionId/abandon', c.abandonSession);

// ── Joined tables (2026-08-25, founder request) ───────────────────────
// One big party across several physical tables shares ONE session/bill.
// Handlers are inline (thin) because all validation lives in tableService
// (uuid checks + tenant scoping + free-table locking); the response only
// needs the id + the updated membership list — the dashboard re-fetches
// the full session/tables views it already polls.
const tableSvc = require('../services/tableService');

router.post('/sessions/:sessionId/join-table', (req, res, next) => {
  tableSvc.joinTable(req.params.businessId, req.params.sessionId, req.body?.tableId)
    .then((s) => res.json({ session: { id: s.id, tableId: s.table_id, joinedTableIds: s.joined_table_ids || [] } }))
    .catch(next);
});
router.post('/sessions/:sessionId/unjoin-table', (req, res, next) => {
  tableSvc.unjoinTable(req.params.businessId, req.params.sessionId, req.body?.tableId)
    .then((s) => res.json({ session: { id: s.id, tableId: s.table_id, joinedTableIds: s.joined_table_ids || [] } }))
    .catch(next);
});

// ── QR settings + per-table token ────────────────────────────────────
router.get('/qr/settings', c.qrSettings);
router.put('/qr/settings', requireRole(['business_owner']), c.qrSettingsUpdate);
router.get('/tables/:tableId/qr', c.qrTokenForTable);
router.post(
  '/tables/:tableId/qr/rotate',
  requireRole(['business_owner']),
  c.qrRotateToken,
);

module.exports = router;
