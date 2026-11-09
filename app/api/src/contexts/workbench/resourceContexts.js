// Authorization workbench — the contexts each access column belongs to (tags,
// logical applications, …), so the analyst can filter permissions by them the way
// the matrix shows them (its Contexts cell). Same join as the matrix
// (matrix/resourceContexts.js); added here: the contexts' parents, so choosing a
// logical application also takes the resources in its sub-contexts.
//
//   withContexts(db, columns) → { columns: each with `contexts` (ids, direct), contexts: [{ id, displayName, contextType, parentId }] }

import { buildResourceContextsSql } from '../../matrix/resourceContexts.js';

export const COLUMN_CONTEXTS_SQL = buildResourceContextsSql(
  `cm."memberId" = ANY($1::uuid[])`,
  { selectPrefix: 'cm."memberId"::text AS "resourceId", ', orderPrefix: 'cm."memberId", ' },
);

// The contexts named and every parent above them, each once.
export const CONTEXT_ANCESTRY_SQL = `
  WITH RECURSIVE up AS (
    SELECT c.id, c."displayName", c."contextType", c."parentContextId"
      FROM "Contexts" c WHERE c.id = ANY($1::uuid[])
    UNION
    SELECT p.id, p."displayName", p."contextType", p."parentContextId"
      FROM "Contexts" p JOIN up ON p.id = up."parentContextId")
  SELECT id::text AS id, "displayName", "contextType", "parentContextId"::text AS "parentId" FROM up`;

/** Each column with the ids of the contexts it is a member of (in the server's order). Pure. */
export function attachContexts(columns, rows) {
  const byResource = new Map();
  for (const r of rows) {
    const key = String(r.resourceId).toLowerCase();
    if (!byResource.has(key)) byResource.set(key, []);
    byResource.get(key).push(String(r.id));
  }
  return columns.map(c => ({ ...c, contexts: byResource.get(String(c.id).toLowerCase()) ?? [] }));
}

/**
 * The access columns with their contexts, and those contexts with their parents.
 * Tolerant like the matrix: no context tables (an older deployment) means no
 * contexts, not a failed workbench.
 */
export async function withContexts(db, columns) {
  const ids = columns.map(c => c.id);
  if (ids.length === 0) return { columns, contexts: [] };
  try {
    const rows = (await db.query(COLUMN_CONTEXTS_SQL, [ids])).rows;
    const direct = [...new Set(rows.map(r => String(r.id)))];
    const contexts = direct.length ? (await db.query(CONTEXT_ANCESTRY_SQL, [direct])).rows : [];
    return { columns: attachContexts(columns, rows), contexts };
  } catch {
    return { columns: columns.map(c => ({ ...c, contexts: [] })), contexts: [] };
  }
}
