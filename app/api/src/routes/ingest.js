// Ingest API endpoints (barrel).
//
// This controller grew past the ~600-line "smell" threshold (audit finding C1),
// so it's split by responsibility into focused routers under ./ingest/:
//
//   ingest/handlers.js    — the generic per-entity ingest endpoints + principals-presence,
//                           sync-log and classify-business-role-assignments
//   ingest/matrixViews.js — /ingest/refresh-views + /ingest/matrix-default-filter
//                           + the refreshKeyword / refreshMatrixViews helpers
//   ingest/helpers.js     — the ingest engine helpers createIngestHandler composes
//
// This file composes the two routers into the default export and re-exports it,
// plus the helpers that ingest.*.test.js and bootstrap.js (refreshMatrixViews)
// import from ./ingest.js — so those consumers, the mount in app.js, the
// OpenAPI-drift guard and every public path are unchanged.

import { Router } from 'express';
import handlersRouter from './ingest/handlers.js';
import matrixViewsRouter from './ingest/matrixViews.js';

const router = Router();
router.use(handlersRouter);
router.use(matrixViewsRouter);

export {
  applyIngestDefaults, recoverSystemPrefix, buildScope, conflictFilterFor, discoverCoreColumns,
  handleSessionPath, applyDeleteByIds, lookupSystemIds, writeAuditLog,
} from './ingest/helpers.js';
export { refreshKeyword, refreshMatrixViews } from './ingest/matrixViews.js';
export default router;
