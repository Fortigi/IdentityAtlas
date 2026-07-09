// Recent-changes + timeline endpoints (barrel).
//
// This controller grew past the ~600-line "smell" threshold (audit finding C1),
// so it's split by responsibility into focused routers under ./recentChanges/:
//
//   recentChanges/changes.js  — /api/{user,resources,access-package,identities}/:id/recent-changes
//   recentChanges/timeline.js — /api/{...}/:id/timeline + the pure timeline builders
//   recentChanges/shared.js   — useSql / UUID_RE + the day/limit clamps
//
// This file composes them onto one router and re-exports it, plus the pure
// timeline builders that recentChanges.timeline.test.js imports from
// ./recentChanges.js — so the tests, the mount in app.js and every public path
// are unchanged.

import { Router } from 'express';
import changesRouter from './recentChanges/changes.js';
import timelineRouter from './recentChanges/timeline.js';

const router = Router();
router.use(changesRouter);
router.use(timelineRouter);

export {
  diffRow, buildEntityTimeline, TIMELINE_SKIP_FIELDS,
  timelineAttrEvents, timelineAssignmentEvents, timelineRelationshipEvents, timelineIdentityMemberEvents,
} from './recentChanges/timeline.js';
export default router;
