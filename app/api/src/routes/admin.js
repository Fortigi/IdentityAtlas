// Admin endpoints (barrel).
//
// This controller grew past the ~600-line "smell" threshold (audit finding C1),
// so it's split by responsibility into focused routers under ./admin/:
//
//   admin/curatedData.js — /api/admin/export|import/curated
//   admin/riskConfig.js  — /api/admin/risk-profile + /api/admin/classifiers
//   admin/maintenance.js — /api/admin/clean-database + /api/admin/history-retention (read/write/prune)
//   admin/dashboard.js   — /api/admin/dashboard-stats + /api/admin/dashboard-timeseries
//   admin/settings.js    — /api/admin/features/toggle + /api/admin/auth-settings
//
// This file just composes them onto one router and re-exports it, so the mount
// in app.js and every public path are unchanged.

import { Router } from 'express';
import curatedDataRouter from './admin/curatedData.js';
import riskConfigRouter from './admin/riskConfig.js';
import maintenanceRouter from './admin/maintenance.js';
import dashboardRouter from './admin/dashboard.js';
import settingsRouter from './admin/settings.js';

const router = Router();
router.use(curatedDataRouter);
router.use(riskConfigRouter);
router.use(maintenanceRouter);
router.use(dashboardRouter);
router.use(settingsRouter);

export default router;
