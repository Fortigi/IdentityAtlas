// Contexts endpoints (barrel, v6).
//
// This controller grew past the ~600-line "smell" threshold (audit finding C1),
// so it's split by responsibility into focused routers under ./contexts/:
//
//   contexts/read.js    — GET /api/contexts (+ /tree, /:id, /:id/members)
//   contexts/crud.js    — POST /api/contexts + PATCH/POST-sync/DELETE /contexts/:id
//   contexts/members.js — POST/DELETE/PATCH-move /contexts/:id/members[...]
//   contexts/roles.js   — GET/PUT /contexts/:id/roles + DELETE /contexts/:id/roles/:roleId
//   contexts/relationships.js — GET/POST /contexts/:id/relationships + DELETE .../:relId
//   contexts/uploads.js — /contexts/uploads (+ /analyze, /preview, /apply): a list uploaded as a tree
//   contexts/interviews.js — /contexts/:id/interviews, /contexts/:id/claims, /contexts/claims/…: interview transcripts and their claims
//   contexts/references.js — GET /contexts/:id/members/:memberId/references (names only)
//   contexts/shared.js  — useSql / UUID_RE / TARGET_TYPES + the writeContexts gate
//
// This file composes them onto one router and re-exports it, so the mount in
// app.js and every public path are unchanged.
//
// See docs/architecture/context-redesign.md for the design.

import { Router } from 'express';
import uploadsRouter from './contexts/uploads.js';
import interviewsRouter from './contexts/interviews.js';
import readRouter from './contexts/read.js';
import crudRouter from './contexts/crud.js';
import membersRouter from './contexts/members.js';
import rolesRouter from './contexts/roles.js';
import relationshipsRouter from './contexts/relationships.js';
import referencesRouter from './contexts/references.js';

const router = Router();
// Before the read router: /contexts/uploads must not be taken for /contexts/:id.
router.use(uploadsRouter);
// Before the read and crud routers too: /contexts/claims/… is not a context id.
router.use(interviewsRouter);
router.use(readRouter);
router.use(crudRouter);
router.use(membersRouter);
router.use(rolesRouter);
router.use(relationshipsRouter);
router.use(referencesRouter);

export default router;
