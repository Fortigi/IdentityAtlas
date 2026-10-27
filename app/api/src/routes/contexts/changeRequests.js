// Change requests — what should change in the source an override overrides.
// Design: docs/architecture/change-requests.md.
//
//   GET /api/change-requests?status=&systemId=&contextId=   the requests, newest open first, with a count per status
//
// Every reader may list them: a request rests on a confirmed decision, which a
// reader already sees. Requests are raised and withdrawn by the decisions
// themselves (contexts/interviews/memberOverrides.js), never through this router.
// Answers 404 while organisation knowledge is off (featureFlags.js orgKnowledge).

import { Router } from 'express';
import * as db from '../../db/connection.js';
import { useSql } from './shared.js';
import { requireFeature } from '../../featureFlags.js';
import { listChangeRequests, parseFilters, ChangeRequestError } from '../../contexts/changeRequests.js';

const router = Router();

router.get('/change-requests', requireFeature('orgKnowledge'), async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'Change requests need the SQL backend' });
  try {
    res.json(await listChangeRequests(db, parseFilters(req.query)));
  } catch (err) {
    if (err instanceof ChangeRequestError) return res.status(err.status).json({ error: err.message });
    console.error('Listing change requests failed:', err?.message);
    res.status(500).json({ error: 'Listing change requests failed' });
  }
});

export default router;
