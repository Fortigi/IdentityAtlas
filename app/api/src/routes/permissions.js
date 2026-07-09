// Permission + access-package + sync-log endpoints (barrel).
//
// This controller grew past the ~600-line "smell" threshold (audit finding C1),
// so it's split by responsibility into focused routers under ./permissions/:
//
//   permissions/grid.js           — /api/permissions + /api/user-columns
//   permissions/accessPackages.js — /api/access-package-groups (+ -resources alias)
//   permissions/syncLog.js        — /api/sync-log
//   permissions/nestedGroups.js   — /api/groups-with-nested + /api/group/:id/nested-groups
//   permissions/shared.js         — the useSql flag + the lazily-imported db module
//
// This file just composes them onto one router and re-exports it, so the mount
// in app.js and every public path are unchanged.

import { Router } from 'express';
import gridRouter from './permissions/grid.js';
import accessPackagesRouter from './permissions/accessPackages.js';
import syncLogRouter from './permissions/syncLog.js';
import nestedGroupsRouter from './permissions/nestedGroups.js';

const router = Router();
router.use(gridRouter);
router.use(accessPackagesRouter);
router.use(syncLogRouter);
router.use(nestedGroupsRouter);

export default router;
