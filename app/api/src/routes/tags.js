// Tags + entity-list endpoints (barrel).
//
// This controller grew past the ~600-line "smell" threshold (audit finding C1),
// so it's split by responsibility into focused routers under ./tags/:
//
//   tags/crud.js     — GET/POST/PATCH/DELETE /api/tags + /api/tags/:id/{assign,unassign,assign-by-filter}
//   tags/entities.js — /api/users, /api/groups, /api/entity-tags + the *-columns-page discovery routes
//   tags/shared.js   — useSql / db + the exported ensureTagTables / buildFilterWhere / ENTITY_TO_TARGET / UUID_RE
//
// This file composes them onto one router and re-exports it, plus the four
// helpers that resources.js, admin/curatedData.js and permissions/grid.js import
// from ./tags.js — so those consumers, the mount in app.js and every public path
// are unchanged.

import { Router } from 'express';
import crudRouter from './tags/crud.js';
import entitiesRouter from './tags/entities.js';

const router = Router();
router.use(crudRouter);
router.use(entitiesRouter);

export { ensureTagTables, buildFilterWhere, ENTITY_TO_TARGET, UUID_RE, parseTags } from './tags/shared.js';
export default router;
