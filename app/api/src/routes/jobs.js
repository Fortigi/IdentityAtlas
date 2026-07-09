// Crawler config + job endpoints (barrel).
//
// This controller grew past the ~600-line "smell" threshold (audit finding C1),
// so it's split by responsibility into focused routers under ./jobs/:
//
//   jobs/configs.js — /api/admin/crawler-configs[...] (persistent crawler configs)
//   jobs/runs.js    — /api/admin/crawler-jobs[...] + /api/admin/status + /api/admin/crawlers/:type/discover
//   jobs/helpers.js — the job-config helpers + gate/useSql + re-exported VALID_JOB_TYPES / validateCrawlerConfig
//
// This file composes the routers and re-exports it, plus the helpers that
// scheduler.js and jobs.*.test.js import from ./jobs.js — so those consumers,
// the mount in app.js and every public path are unchanged.

import { Router } from 'express';
import configsRouter from './jobs/configs.js';
import runsRouter from './jobs/runs.js';

const router = Router();
router.use(configsRouter);
router.use(runsRouter);

export {
  maskConfig, mergeConfigForUpdate, validateCreateJobBody, resolveJobConfig,
  resolveUploadFolder, prepareJobConfig, checkSingletonConflict, resolveCreatedBy,
  VALID_JOB_TYPES, validateCrawlerConfig,
} from './jobs/helpers.js';
export default router;
