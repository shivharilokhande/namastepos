// NamastePOS backend - addon routes
// Mounted twice:
//   /v1/addons                              public catalog
//   /v1/businesses/:businessId/addons       per-tenant (active list, subscribe, cancel)

const express = require('express');
const c = require('../controllers/addonController');
const { requireAuth, requireBusinessOwnership, requireRole } = require('../middleware/auth');

const publicRouter = express.Router();
publicRouter.get('/', c.catalog);
module.exports.publicRouter = publicRouter;

const businessRouter = express.Router({ mergeParams: true });
businessRouter.use(requireAuth, requireBusinessOwnership);
businessRouter.get   ('/',                       c.myAddons);
businessRouter.post  ('/subscribe',              requireRole('business_owner'), ...c.subscribe);
businessRouter.post  ('/:slug/cancel',           requireRole('business_owner'), c.cancel);
businessRouter.post  ('/:slug/resume',           requireRole('business_owner'), c.resume);
businessRouter.put   ('/:slug/settings',         requireRole(['business_owner','staff_manager']), c.updateSettings);
module.exports.businessRouter = businessRouter;
