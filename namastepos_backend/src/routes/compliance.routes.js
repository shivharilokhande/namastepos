// NamastePOS backend - /v1/compliance/* — public DPDP endpoints.
//
// No auth required. These are reachable by anyone who needs to:
//   - Look up the published grievance officer contact
//   - File a grievance (mandatory under DPDP s.13)
//   - Record cookie-banner / guest consent
//
// Mounted at /v1/compliance in app.js.

const express = require('express');
const c = require('../controllers/complianceController');

const router = express.Router();

router.get ('/grievance-officer', c.publicGrievanceOfficer);
router.post('/grievance',         ...c.publicFileGrievance);
router.post('/consent',           ...c.publicRecordConsent);
router.post('/guest-consent',     ...c.guestRecordConsent);

module.exports = router;
