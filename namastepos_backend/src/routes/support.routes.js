// Tenant-side support / ticketing (X7).
// Mounted at /v1/businesses/:businessId/support — a restaurant raises and
// replies to its own tickets; support answers from the admin console.

const express = require('express');
const router = express.Router({ mergeParams: true });
const { requireAuth, requireBusinessOwnership } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { Forbidden } = require('../utils/errors');
const support = require('../services/supportService');

router.use(requireAuth, requireBusinessOwnership);

// List this business's tickets
router.get('/', asyncHandler(async (req, res) => {
  res.json({ tickets: await support.listTickets({ businessId: req.params.businessId, status: req.query.status }) });
}));

// Raise a ticket
router.post('/', asyncHandler(async (req, res) => {
  const ticket = await support.createTicket({
    businessId: req.params.businessId,
    subject: req.body.subject,
    priority: req.body.priority,
    body: req.body.body,
    authorUserId: req.user?.id,
    authorEmail: req.user?.email,
    byAdmin: false,
  });
  res.status(201).json({ ticket });
}));

// View a ticket (must belong to this business)
router.get('/:ticketId', asyncHandler(async (req, res) => {
  const ticket = await support.getTicket(req.params.ticketId);
  if (ticket.businessId !== req.params.businessId) throw new Forbidden('Not your ticket');
  res.json({ ticket });
}));

// Reply to a ticket
router.post('/:ticketId/messages', asyncHandler(async (req, res) => {
  const existing = await support.getTicket(req.params.ticketId);
  if (existing.businessId !== req.params.businessId) throw new Forbidden('Not your ticket');
  const ticket = await support.addMessage(req.params.ticketId, {
    body: req.body.body, authorType: 'tenant',
    authorId: req.user?.id, authorEmail: req.user?.email,
  });
  res.json({ ticket });
}));

module.exports = router;
