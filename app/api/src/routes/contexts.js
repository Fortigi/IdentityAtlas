// Contexts endpoints (barrel, v6).
//
// This controller grew past the ~600-line "smell" threshold (audit finding C1),
// so it's split by responsibility into focused routers under ./contexts/:
//
//   contexts/read.js    — GET /api/contexts (+ /tree, /:id, /:id/members)
//   contexts/crud.js    — POST /api/contexts + PATCH/POST-sync/DELETE /contexts/:id
//   contexts/members.js — POST/DELETE/PATCH-move /contexts/:id/members[...]
//   contexts/shared.js  — useSql / UUID_RE / TARGET_TYPES + the writeContexts gate
//
// This file composes them onto one router and re-exports it, so the mount in
// app.js and every public path are unchanged.
//
// See docs/architecture/context-redesign.md for the design.

import { Router } from 'express';
import readRouter from './contexts/read.js';
import crudRouter from './contexts/crud.js';
import membersRouter from './contexts/members.js';

const router = Router();
router.use(readRouter);
router.use(crudRouter);
router.use(membersRouter);

export default router;
