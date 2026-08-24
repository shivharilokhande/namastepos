// NamastePOS backend - reports routes

const express = require('express');
const c = require('../controllers/reportsController');
const { requireAuth, requireBusinessOwnership } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });
router.use(requireAuth, requireBusinessOwnership);

router.get('/daily',   ...c.daily);
router.get('/monthly', ...c.monthly);

// Push 15 — Schedule III income statement (P&L) with exports
router.get('/income-statement',       ...c.incomeStatement);
router.get('/income-statement.pdf',   ...c.incomeStatementPdf);
router.get('/income-statement.xlsx',  ...c.incomeStatementXlsx);
router.get('/income-statement.csv',   ...c.incomeStatementCsv);

// Push 15h — Income / Expense / Invoice detail registers
router.get('/income-register',         ...c.incomeRegister);
router.get('/income-register.pdf',     ...c.incomeRegisterPdf);
router.get('/income-register.xlsx',    ...c.incomeRegisterXlsx);
router.get('/income-register.csv',     ...c.incomeRegisterCsv);

router.get('/expense-register',        ...c.expenseRegister);
router.get('/expense-register.pdf',    ...c.expenseRegisterPdf);
router.get('/expense-register.xlsx',   ...c.expenseRegisterXlsx);
router.get('/expense-register.csv',    ...c.expenseRegisterCsv);

router.get('/invoice-register',        ...c.invoiceRegister);
router.get('/invoice-register.pdf',    ...c.invoiceRegisterPdf);
router.get('/invoice-register.xlsx',   ...c.invoiceRegisterXlsx);
router.get('/invoice-register.csv',    ...c.invoiceRegisterCsv);

module.exports = router;
