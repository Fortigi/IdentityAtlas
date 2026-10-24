// The ingest's hook: after a sync wrote a source's contexts or their members,
// apply that source's tree adjustments again — the sync just put back what the
// source says (parents, names, memberships), the adjustments put the analyst's
// corrections back on top.

import { reapplyForSystem } from './service.js';

const TREE_TABLES = new Set(['Contexts', 'ContextMembers']);

export async function reapplyAfterSync(runner, tableName, systemId) {
  if (!TREE_TABLES.has(tableName) || systemId == null) return 0;
  return reapplyForSystem(runner, systemId);
}
