// NamastePOS backend - expense endpoints

const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const expense = require('../services/expenseService');

const createBody = Joi.object({
  // Founder bug #4 (2026-08-25): pilot restaurants book salaries, gas,
  // electricity etc. — keep in sync with the expense_category enum
  // (migration 058) and the dashboard/Flutter pickers.
  category: Joi.string().valid(
    'ingredients', 'fuel', 'labor', 'rent', 'utilities',
    'packaging', 'marketing', 'maintenance',
    'chef_salary', 'helper_salary', 'staff_salary', 'gas', 'electricity',
    'water', 'transport', 'equipment', 'cleaning', 'license_fees',
    'other'
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
  // NP-128: server-side pagination (mirrors orderController.listQuery).
  // NO default: fielded mobile builds send no limit and SUM the list for
  // monthly P&L — a silent default would understate expenses (review HIGH).
  // Pagination applies only when the client opts in.
  limit: Joi.number().integer().min(1).max(200),
  offset: Joi.number().integer().min(0).default(0),
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
      // NP-128: `total` = full match count (page-independent); `count` stays
      // the page length so the response shape is backward-compatible.
      res.json({ expenses, count: expenses.length, total: expenses.total ?? expenses.length });
    }),
  ],
  remove: asyncHandler(async (req, res) => {
    const result = await expense.softDelete(req.params.businessId, req.params.expenseId);
    res.json(result);
  }),
};
