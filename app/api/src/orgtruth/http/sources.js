// Organisation truth — sources (owned by workstream T1, see the handover).
//
//   POST /api/org-truth/sources                multipart upload (field `file`) + kind, displayName, observedAt
//   GET  /api/org-truth/sources                list (no content)
//   GET  /api/org-truth/sources/:id            one source (no content)
//   GET  /api/org-truth/sources/:id/download   the original bytes
//   GET  /api/org-truth/sources/:id/columns    column profile of a list source
//
// Nothing is declared yet: the composed router (routes/orgTruth.js) answers 501
// for any /org-truth path no sub-router claims.
import { Router } from 'express';

const router = Router();

export default router;
