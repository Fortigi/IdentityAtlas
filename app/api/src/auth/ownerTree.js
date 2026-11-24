// The tree a context owner navigates by: the contexts they hold and the sub-units
// below them, nested, with the role they hold on each. Built only from the
// owner's own scope (auth/contextOwner.js), so it can show nothing else. A variant
// of a held unit is in that scope but is not part of what they answer for, so it
// is left out here unless they hold it themselves.

export const OWNER_TREE_SQL = `
    SELECT id, variant, "targetType", "contextType", "contextCategory", "displayName",
           "parentContextId", "directMemberCount", "totalMemberCount"
      FROM "Contexts"
     WHERE id = ANY($1::uuid[])
     ORDER BY "displayName"`;

const MAX_ANCESTORS = 25;
const key = id => String(id).toLowerCase();

/** Nested nodes under the held contexts. A corrupt parent cycle cannot loop. Pure. */
export function buildOwnerForest(rows, held) {
  const roleOf = new Map(held.map(c => [key(c.id), c.role]));
  const nodes = new Map(rows.map(r => [key(r.id), { ...r, role: roleOf.get(key(r.id)) ?? null, children: [] }]));
  const childrenOf = new Map();
  for (const r of rows) {
    if (!r.parentContextId) continue;
    const parent = key(r.parentContextId);
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent).push(key(r.id));
  }

  const kept = new Set();
  const attach = (id) => {
    kept.add(id);
    for (const child of childrenOf.get(id) || []) {
      if (kept.has(child)) continue;
      nodes.get(id).children.push(nodes.get(child));
      attach(child);
    }
  };
  const heldIds = held.map(c => key(c.id)).filter(id => nodes.has(id));
  // A held context anywhere below another held one is a child, not a second root.
  const heldSet = new Set(heldIds);
  const belowHeld = (id) => {
    const seen = new Set([id]);
    let up = nodes.get(id).parentContextId;
    while (up && nodes.has(key(up)) && !seen.has(key(up))) {
      if (heldSet.has(key(up))) return true;
      seen.add(key(up));
      up = nodes.get(key(up)).parentContextId;
    }
    return false;
  };
  const roots = heldIds.filter(id => !belowHeld(id));
  roots.forEach(attach);
  // Only a parent cycle leaves a held context unreached.
  for (const id of heldIds) {
    if (!kept.has(id)) { roots.push(id); attach(id); }
  }
  return roots.map(id => nodes.get(id));
}

// $1 the roots' ids. The units above each root, nearest first in `depth`; names
// only, because they are outside the owner's scope. A corrupt parent cycle stops.
export const OWNER_ANCESTORS_SQL = `
    WITH RECURSIVE up AS (
      SELECT k.id AS "rootId", c.id, c."displayName", c."parentContextId", 1 AS depth, ARRAY[k.id, c.id] AS path
        FROM "Contexts" k JOIN "Contexts" c ON c.id = k."parentContextId"
       WHERE k.id = ANY($1::uuid[])
      UNION ALL
      SELECT u."rootId", c.id, c."displayName", c."parentContextId", u.depth + 1, u.path || c.id
        FROM up u JOIN "Contexts" c ON c.id = u."parentContextId"
       WHERE u.depth < ${MAX_ANCESTORS} AND c.id <> ALL(u.path)
    )
    SELECT "rootId", "displayName", depth FROM up`;

/** Each root with `ancestors`: the names above it, top of the tree first. Pure. */
export function withAncestors(roots, rows) {
  const byRoot = new Map();
  for (const r of rows) {
    const id = key(r.rootId);
    if (!byRoot.has(id)) byRoot.set(id, []);
    byRoot.get(id).push(r);
  }
  return roots.map(root => ({
    ...root,
    ancestors: (byRoot.get(key(root.id)) || []).sort((a, b) => b.depth - a.depth).map(r => r.displayName),
  }));
}

export async function loadOwnerTree(db, owner) {
  const { rows } = await db.query(OWNER_TREE_SQL, [[...owner.contextIds]]);
  const roots = buildOwnerForest(rows, owner.contexts);
  if (!roots.length) return roots;
  const above = await db.query(OWNER_ANCESTORS_SQL, [roots.map(r => r.id)]);
  return withAncestors(roots, above.rows);
}
