// Identity Atlas Interviews — API routes (experimental, feature `interviews`).
//
// Versioned under /api/v1/interviews: the first client is a native app that cannot be
// redeployed with the server, so the contract it is built against has to stay put.
// Documented in openapi.yaml under "Interviews"; design in docs/architecture/interviews.md.
//
// Gates per route (interviews/http/gates.js), never on the mount. The lookup router is
// composed first so /v1/interviews/context and /v1/interviews/entities/search are never
// taken for an interview id.

import { Router } from 'express';
import lookupRouter from '../interviews/http/lookup.js';
import sessionsRouter from '../interviews/http/sessions.js';
import claimsRouter from '../interviews/http/claims.js';

const router = Router();
router.use(lookupRouter);
router.use(sessionsRouter);
router.use(claimsRouter);

export default router;
