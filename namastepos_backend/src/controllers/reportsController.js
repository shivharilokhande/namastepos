// NamastePOS backend - reports endpoints

const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const reports = require('../services/reportService');
const incomeStmt = require('../services/incomeStatementService');
const detail = require('../services/detailReportsService');
const exporters = require('../services/reportExporters');

const dailyQuery = Joi.object({
  date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required(),
});

const monthlyQuery = Joi.object({
  month: Joi.string().pattern(/^\d{4}-\d{2}$/).required(),
});

const dateRangeQuery = Joi.object({
  startDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required(),
  endDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required(),
});

module.exports = {
  daily: [
    validate({ query: dailyQuery }),
    asyncHandler(async (req, res) => {
      const report = await reports.dailyReport(req.params.businessId, req.query.date);
      res.json({ report });
    }),
  ],
  monthly: [
    validate({ query: monthlyQuery }),
    asyncHandler(async (req, res) => {
      const report = await reports.monthlyReport(req.params.businessId, req.query.month);
      res.json({ report });
    }),
  ],

  // Push 15 — Schedule III income statement (P&L) + exports
  incomeStatement: [
    validate({ query: dateRangeQuery }),
    asyncHandler(async (req, res) => {
      try {
        const data = await incomeStmt.incomeStatement(
          req.params.businessId,
          { startDate: req.query.startDate, endDate: req.query.endDate },
        );
        res.json({ report: data });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[reports.incomeStatement] full failure:', e?.message, e?.stack);
        // Surface a specific error code so the dashboard shows something
        // more useful than a generic 500.
        const err = new Error(`Failed to build P&L report: ${e?.message || 'unknown error'}`);
        err.statusCode = 500;
        err.code = 'PNL_BUILD_FAILED';
        throw err;
      }
    }),
  ],
  incomeStatementPdf: [
    validate({ query: dateRangeQuery }),
    asyncHandler(async (req, res) => {
      const data = await incomeStmt.incomeStatement(
        req.params.businessId,
        { startDate: req.query.startDate, endDate: req.query.endDate },
      );
      exporters.streamIncomeStatementPdf(res, data);
    }),
  ],
  incomeStatementXlsx: [
    validate({ query: dateRangeQuery }),
    asyncHandler(async (req, res) => {
      const data = await incomeStmt.incomeStatement(
        req.params.businessId,
        { startDate: req.query.startDate, endDate: req.query.endDate },
      );
      await exporters.streamIncomeStatementXlsx(res, data);
    }),
  ],
  incomeStatementCsv: [
    validate({ query: dateRangeQuery }),
    asyncHandler(async (req, res) => {
      const data = await incomeStmt.incomeStatement(
        req.params.businessId,
        { startDate: req.query.startDate, endDate: req.query.endDate },
      );
      exporters.streamIncomeStatementCsv(res, data);
    }),
  ],

  // Push 15h — Income / Expense / Invoice register reports
  incomeRegister: [
    validate({ query: dateRangeQuery }),
    asyncHandler(async (req, res) => {
      const data = await detail.incomeRegister(
        req.params.businessId,
        { startDate: req.query.startDate, endDate: req.query.endDate },
      );
      res.json({ report: data });
    }),
  ],
  incomeRegisterPdf: [
    validate({ query: dateRangeQuery }),
    asyncHandler(async (req, res) => {
      const data = await detail.incomeRegister(
        req.params.businessId,
        { startDate: req.query.startDate, endDate: req.query.endDate },
      );
      exporters.streamIncomeRegisterPdf(res, data);
    }),
  ],
  incomeRegisterXlsx: [
    validate({ query: dateRangeQuery }),
    asyncHandler(async (req, res) => {
      const data = await detail.incomeRegister(
        req.params.businessId,
        { startDate: req.query.startDate, endDate: req.query.endDate },
      );
      await exporters.streamIncomeRegisterXlsx(res, data);
    }),
  ],
  incomeRegisterCsv: [
    validate({ query: dateRangeQuery }),
    asyncHandler(async (req, res) => {
      const data = await detail.incomeRegister(
        req.params.businessId,
        { startDate: req.query.startDate, endDate: req.query.endDate },
      );
      exporters.streamIncomeRegisterCsv(res, data);
    }),
  ],

  expenseRegister: [
    validate({ query: dateRangeQuery }),
    asyncHandler(async (req, res) => {
      const data = await detail.expenseRegister(
        req.params.businessId,
        { startDate: req.query.startDate, endDate: req.query.endDate },
      );
      res.json({ report: data });
    }),
  ],
  expenseRegisterPdf: [
    validate({ query: dateRangeQuery }),
    asyncHandler(async (req, res) => {
      const data = await detail.expenseRegister(
        req.params.businessId,
        { startDate: req.query.startDate, endDate: req.query.endDate },
      );
      exporters.streamExpenseRegisterPdf(res, data);
    }),
  ],
  expenseRegisterXlsx: [
    validate({ query: dateRangeQuery }),
    asyncHandler(async (req, res) => {
      const data = await detail.expenseRegister(
        req.params.businessId,
        { startDate: req.query.startDate, endDate: req.query.endDate },
      );
      await exporters.streamExpenseRegisterXlsx(res, data);
    }),
  ],
  expenseRegisterCsv: [
    validate({ query: dateRangeQuery }),
    asyncHandler(async (req, res) => {
      const data = await detail.expenseRegister(
        req.params.businessId,
        { startDate: req.query.startDate, endDate: req.query.endDate },
      );
      exporters.streamExpenseRegisterCsv(res, data);
    }),
  ],

  invoiceRegister: [
    validate({ query: dateRangeQuery }),
    asyncHandler(async (req, res) => {
      const data = await detail.invoiceRegister(
        req.params.businessId,
        { startDate: req.query.startDate, endDate: req.query.endDate },
      );
      res.json({ report: data });
    }),
  ],
  invoiceRegisterPdf: [
    validate({ query: dateRangeQuery }),
    asyncHandler(async (req, res) => {
      const data = await detail.invoiceRegister(
        req.params.businessId,
        { startDate: req.query.startDate, endDate: req.query.endDate },
      );
      exporters.streamInvoiceRegisterPdf(res, data);
    }),
  ],
  invoiceRegisterXlsx: [
    validate({ query: dateRangeQuery }),
    asyncHandler(async (req, res) => {
      const data = await detail.invoiceRegister(
        req.params.businessId,
        { startDate: req.query.startDate, endDate: req.query.endDate },
      );
      await exporters.streamInvoiceRegisterXlsx(res, data);
    }),
  ],
  invoiceRegisterCsv: [
    validate({ query: dateRangeQuery }),
    asyncHandler(async (req, res) => {
      const data = await detail.invoiceRegister(
        req.params.businessId,
        { startDate: req.query.startDate, endDate: req.query.endDate },
      );
      exporters.streamInvoiceRegisterCsv(res, data);
    }),
  ],
};
