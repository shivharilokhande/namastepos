// NamastePOS backend - expense routes

const express = require('express');
const c = require('../controllers/expenseController');
const { requireAuth, requireBusinessOwnership } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });
router.use(requireAuth, requireBusinessOwnership);

router.post  ('/',              ...c.create);
router.get   ('/',              ...c.list);
router.delete('/:expenseId',    c.remove);

module.exports = router;
