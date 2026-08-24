// NamastePOS backend - invitation accept (no tenant prefix)

const express = require('express');
const c = require('../controllers/staffController');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.post('/accept', requireAuth, ...c.acceptInvite);

module.exports = router;
