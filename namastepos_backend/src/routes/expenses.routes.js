// NamastePOS backend - expense routes

const express = require('express');
const c = require('../controllers/expenseController');
const { requireAuth, requireBusinessOwnership, requireStaffPerm, requireRole } =
  require('../middleware/auth');

const router = express.Router({ mergeParams: true });
router.use(requireAuth, requireBusinessOwnership);

// NP-201: was authenticated-only, so a `staff_kitchen` cook could read the
// whole expense ledger and create/delete entries in it. Accept either the new
// `expenses` key or the pre-existing `expense_register` one, so a manager
// whose owner had already saved an explicit permission list (which cannot
// contain a key that did not exist yet) keeps working.
const canExpenses = requireStaffPerm(['expenses', 'expense_register']);

router.post  ('/',              canExpenses, ...c.create);
router.get   ('/',              canExpenses, ...c.list);
// Deleting a booked expense rewrites the P&L — owner/manager only.
router.delete('/:expenseId',    requireRole(['business_owner', 'staff_manager']), c.remove);

module.exports = router;
