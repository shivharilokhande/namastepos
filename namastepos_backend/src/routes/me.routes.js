// NamastePOS backend - /v1/me/* — DPDP self-service routes.
//
// Every authenticated user can:
//   - View / record / withdraw their consents
//   - File a data-subject request
//   - Download their data (portability)
//   - Erase their own account
//   - File a correction request
//
// Mounted at /v1/me in app.js.

const express = require('express');
const c = require('../controllers/complianceController');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Consents
router.get('/consents', c.meCurrentConsents);
router.get('/consents/history', c.meConsentHistory);
router.post('/consents', ...c.meRecordConsent);

// Data subject requests
router.get('/dsr', c.meListDSRs);
router.post('/dsr', ...c.meFileDSR);
router.post('/correct', ...c.meFileCorrection);

// Portability + erasure (the big two)
router.get('/export', c.meExport);
router.delete('/account', c.meEraseAccount);

module.exports = router;
