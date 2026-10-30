// Shared config + constants for the contexts endpoints.
//
// Extracted from routes/contexts.js (audit finding C1) so the split sub-routers
// share one definition. No behaviour change — pure code move.

import { requirePermission } from '../../middleware/auth.js';
import { CONTEXT_TARGET_TYPES } from '../../ingest/validation.js';

export const useSql = process.env.USE_SQL === 'true';
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// One list for the ingest and the contexts routes (and the core ontology check).
export const TARGET_TYPES = new Set(CONTEXT_TARGET_TYPES);

// The plugin whose trees the member-move route and /api/org-chart key on. A
// tree is "the manager hierarchy" by its source algorithm, not by its
// contextType — a type is a template choice, the algorithm is the provenance.
export const MANAGER_HIERARCHY_ALGORITHM = 'manager-hierarchy';

// Same admin who configures context-algorithm plugins owns the resulting
// contexts (and manual contexts edited here through the UI).
// Building contexts was split out of that admin permission as `data.write.contexts`;
// either one grants it, so no existing role mapping loses access.
export const writeContexts = requirePermission('data.write.contexts', 'admin.context-plugins');
