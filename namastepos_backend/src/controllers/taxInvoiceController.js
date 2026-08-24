// NamastePOS backend - tax invoice endpoints (Push 15c).

const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const svc = require('../services/taxInvoiceService');
const exporters = require('../services/reportExporters');

const issueBody = Joi.object({
  orderId: Joi.string().uuid().required(),
  recipientName:    Joi.string().max(255).allow('', null),
  recipientGstin:   Joi.string().length(15).allow('', null),
  recipientAddress: Joi.string().max(500).allow('', null),
  recipientPhone:   Joi.string().max(20).allow('', null),
  placeOfSupply:    Joi.string().length(2).allow('', null),
  reverseCharge:    Joi.boolean().default(false),
});

const listQuery = Joi.object({
  startDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/),
  endDate:   Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/),
  status:    Joi.string().valid('issued', 'cancelled'),
});

const cancelBody = Joi.object({
  reason: Joi.string().max(500).allow('', null),
});

module.exports = {
  // POST /businesses/:bid/tax-invoices — issue an invoice for an order.
  // Idempotent: re-calling for the same order returns the existing one.
  issue: [
    validate({ body: issueBody }),
    asyncHandler(async (req, res) => {
      const invoice = await svc.issueFromOrder(
        req.params.businessId,
        req.body.orderId,
        {
          recipientName:    req.body.recipientName || null,
          recipientGstin:   req.body.recipientGstin || null,
          recipientAddress: req.body.recipientAddress || null,
          recipientPhone:   req.body.recipientPhone || null,
          placeOfSupply:    req.body.placeOfSupply || null,
          reverseCharge:    !!req.body.reverseCharge,
          issuedByUserId:   req.user?.id,
        }
      );
      res.status(201).json({ invoice });
    }),
  ],

  list: [
    validate({ query: listQuery }),
    asyncHandler(async (req, res) => {
      const invoices = await svc.list(req.params.businessId, req.query);
      res.json({ invoices });
    }),
  ],

  getOne: asyncHandler(async (req, res) => {
    const invoice = await svc.getById(req.params.businessId, req.params.invoiceId);
    res.json({ invoice });
  }),

  // Render the invoice as PDF (for download / print preview).
  pdf: asyncHandler(async (req, res) => {
    const invoice = await svc.getById(req.params.businessId, req.params.invoiceId);
    exporters.streamTaxInvoicePdf(res, invoice);
  }),

  cancel: [
    validate({ body: cancelBody }),
    asyncHandler(async (req, res) => {
      const invoice = await svc.cancel(
        req.params.businessId, req.params.invoiceId,
        req.body.reason, req.user?.id
      );
      res.json({ invoice });
    }),
  ],
};
