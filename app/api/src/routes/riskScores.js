// Risk-scores endpoints (barrel).
//
// This controller grew past the ~600-line "smell" threshold (audit finding C1),
// so it's split by responsibility into focused routers under ./riskScores/:
//
//   riskScores/list.js   — GET /api/risk-scores (summary) + the per-type paginated lists
//   riskScores/entity.js — GET /api/risk-scores/:type/:id + PUT/DELETE .../override
//   riskScores/shared.js — useSql / db + the riskTableExists / parseJsonColumns helpers + TEMPORAL_FILTER
//
// This file composes them onto one router and re-exports it, so the mount in
// app.js and every public path are unchanged.

import { Router } from 'express';
import listRouter from './riskScores/list.js';
import entityRouter from './riskScores/entity.js';
import { requireFeature } from '../featureFlags.js';

const router = Router();
// Scores stay in the database while risk scoring is off, but are not served.
// Path-scoped: the router shares the '/api' mount with every other one.
router.use('/risk-scores', requireFeature('riskScoring'));
router.use(listRouter);
router.use(entityRouter);

export default router;
