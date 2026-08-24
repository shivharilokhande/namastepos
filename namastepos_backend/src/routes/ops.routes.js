// NamastePOS backend - KOT + tables routes (mounted at /businesses/:businessId/ops)

const express = require('express');
const c = require('../controllers/opsController');
const { requireAuth, requireBusinessOwnership, requireRole } = require('../middleware/auth');
const sub = require('../services/subscriptionService');

const router = express.Router({ mergeParams: true });
router.use(requireAuth, requireBusinessOwnership);

// ── KOT stations ──────────────────────────────────────────────────────
router.get   ('/kot/stations',                 c.listStations);
router.post  ('/kot/stations',                 requireRole(['business_owner']), ...c.createStation);
router.put   ('/kot/stations/:stationId',      requireRole(['business_owner']), ...c.updateStation);
router.delete('/kot/stations/:stationId',      requireRole(['business_owner']), c.deleteStation);

// ── KOT tickets (live queue) ───────────────────────────────────────────
router.get   ('/kot/tickets',                  c.listTickets);
router.put   ('/kot/tickets/:ticketId/status', ...c.updateTicketStatus);
router.post  ('/kot/tickets/:ticketId/printed', c.markTicketPrinted);

// ── Floors ────────────────────────────────────────────────────────────
// Push 16d — plan-gated floor creation. enforceLimit('floors') reads
// plan.limits.floors and 402s when the count would exceed it.
router.get   ('/floors',              c.listFloors);
router.post  ('/floors',              requireRole(['business_owner', 'staff_manager']),
                                      sub.enforceLimit('floors'), ...c.createFloor);
router.put   ('/floors/:floorId',     requireRole(['business_owner', 'staff_manager']), ...c.updateFloor);
router.delete('/floors/:floorId',     requireRole(['business_owner']), c.deleteFloor);

// ── Tables ────────────────────────────────────────────────────────────
// Push 16d — plan-gated table creation.
router.get   ('/tables',              c.listTables);
router.post  ('/tables',              requireRole(['business_owner', 'staff_manager']),
                                      sub.enforceLimit('tables'), ...c.createTable);
router.put   ('/tables/:tableId',     requireRole(['business_owner', 'staff_manager']), ...c.updateTable);
router.delete('/tables/:tableId',     requireRole(['business_owner']), c.deleteTable);

// ── Sessions (seat / close) ──────────────────────────────────────────
router.post  ('/tables/:tableId/sessions', ...c.openSession);
router.get   ('/sessions/:sessionId',      c.sessionDetail);
router.post  ('/sessions/:sessionId/close',   ...c.closeSession);
// Push 22 — release a table whose customer left without ordering.
router.post  ('/sessions/:sessionId/abandon', c.abandonSession);

// ── QR settings + per-table token ────────────────────────────────────
router.get   ('/qr/settings',           c.qrSettings);
router.put   ('/qr/settings',           requireRole(['business_owner']), c.qrSettingsUpdate);
router.get   ('/tables/:tableId/qr',    c.qrTokenForTable);
router.post  ('/tables/:tableId/qr/rotate',
              requireRole(['business_owner']),
              c.qrRotateToken);

module.exports = router;
