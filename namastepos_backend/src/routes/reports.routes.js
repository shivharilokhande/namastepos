// NamastePOS backend - reports routes

const express = require('express');
const c = require('../controllers/reportsController');
const { requireAuth, requireBusinessOwnership, requireStaffPerm } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });
router.use(requireAuth, requireBusinessOwnership);

// NP-201: this whole router was authenticated but NOT authorised — every
// route below named no role and no permission, so any active member of the
// business (a `staff_kitchen` cook included) could pull revenue, P&L, margins
// and the full income/expense/invoice registers straight from the API. The
// mobile drawer hid the screens; the endpoints answered anyway.
//
// Permission choices mirror staffService.DEFAULT_PERMS_BY_ROLE exactly, so the
// server now enforces the split the role table already documented:
//   • `reports`        — summary revenue (manager, cashier)
//   • `pnl_statement`  — P&L / income statement (manager only; NOT cashier)
//   • `*_register`     — the matching detail register
const canReports = requireStaffPerm('reports');
const canPnl = requireStaffPerm('pnl_statement');
const canIncomeReg = requireStaffPerm('income_register');
const canExpenseReg = requireStaffPerm('expense_register');
const canInvoiceReg = requireStaffPerm('invoice_register');

router.get('/daily', canReports, ...c.daily);
router.get('/monthly', canReports, ...c.monthly);

// Push 15 — Schedule III income statement (P&L) with exports
router.get('/income-statement', canPnl, ...c.incomeStatement);
router.get('/income-statement.pdf', canPnl, ...c.incomeStatementPdf);
router.get('/income-statement.xlsx', canPnl, ...c.incomeStatementXlsx);
router.get('/income-statement.csv', canPnl, ...c.incomeStatementCsv);

// Push 15h — Income / Expense / Invoice detail registers
router.get('/income-register', canIncomeReg, ...c.incomeRegister);
router.get('/income-register.pdf', canIncomeReg, ...c.incomeRegisterPdf);
router.get('/income-register.xlsx', canIncomeReg, ...c.incomeRegisterXlsx);
router.get('/income-register.csv', canIncomeReg, ...c.incomeRegisterCsv);

router.get('/expense-register', canExpenseReg, ...c.expenseRegister);
router.get('/expense-register.pdf', canExpenseReg, ...c.expenseRegisterPdf);
router.get('/expense-register.xlsx', canExpenseReg, ...c.expenseRegisterXlsx);
router.get('/expense-register.csv', canExpenseReg, ...c.expenseRegisterCsv);

router.get('/invoice-register', canInvoiceReg, ...c.invoiceRegister);
router.get('/invoice-register.pdf', canInvoiceReg, ...c.invoiceRegisterPdf);
router.get('/invoice-register.xlsx', canInvoiceReg, ...c.invoiceRegisterXlsx);
router.get('/invoice-register.csv', canInvoiceReg, ...c.invoiceRegisterCsv);

module.exports = router;
