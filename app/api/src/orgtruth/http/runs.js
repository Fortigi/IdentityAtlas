// Organisation truth — import runs (owned by workstream T1; the dry-run's link
// statistics and the end-of-run linking come from T2 through linking/stats.js
// and linking/run.js).
//
//   POST /api/org-truth/runs/dry-run           { sourceId, recipe, linkRules, mode } → data-quality report, nothing written
//   POST /api/org-truth/runs                   { sourceId, profileId, mode } → 202 + run row; runs in the background
//   GET  /api/org-truth/runs                   the 50 most recent runs
//   GET  /api/org-truth/runs/:id               one run (for the polling UI)
import { Router } from 'express';

const router = Router();

export default router;
