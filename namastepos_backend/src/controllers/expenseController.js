// NamastePOS backend - expense endpoints

const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const expense = require('../services/expenseService');

const createBody = Joi.object({
  category: Joi.string().valid(
    'ingredients', 'fuel', 'labor', 'rent', 'utilities',
    'packaging', 'marketing', 'maintenance', 'other'
  ).default('other'),
  amount: Joi.number().positive().precision(2).required(),
  description: Joi.string().max(500).allow('', null),
  date: Joi.date().iso().required(),
  receiptUrl: Joi.string().uri().allow('', null),
});

const listQuery = Joi.object({
  startDate: Joi.date().iso(),
  endDate: Joi.date().iso(),
  category: Joi.string().max(50),
});

module.exports = {
  create: [
    validate({ body: createBody }),
    asyncHandler(async (req, res) => {
      const e = await expense.create(req.params.businessId, req.body);
      res.status(201).json({ expense: e });
    }),
  ],
  list: [
    validate({ query: listQuery }),
    asyncHandler(async (req, res) => {
      const expenses = await expense.list(req.params.businessId, req.query);
      res.json({ expenses, count: expenses.length });
    }),
  ],
  remove: asyncHandler(async (req, res) => {
    const result = await expense.softDelete(req.params.businessId, req.params.expenseId);
    res.json(result);
  }),
};
