// Identities endpoints (barrel).
//
// This controller grew past the ~600-line "smell" threshold (audit finding C1),
// so it's split by responsibility into focused routers under ./identities/:
//
//   identities/list.js      — /api/identities + /api/identity-columns
//   identities/detail.js    — /api/identities/:id (+ contexts/assignments/account-matrix) + /api/identities/by-user/:userId
//   identities/overrides.js — PUT/DELETE /api/identities/:id/members/:userId/override
//   identities/shared.js    — useSql / db / UUID_RE / hasTable + the exported enrichMembers
//
// This file composes them onto one router and re-exports it (plus enrichMembers,
// which identities.enrich.test.js imports), so the mount in app.js and every
// public path are unchanged.

import { Router } from 'express';
import listRouter from './identities/list.js';
import detailRouter from './identities/detail.js';
import overridesRouter from './identities/overrides.js';

const router = Router();
router.use(listRouter);
router.use(detailRouter);
router.use(overridesRouter);

export { enrichMembers } from './identities/shared.js';
export default router;
