// Shared implementation behind the two system-membership plugins.
//
// "One context per connected system" ships as two registered plugins rather
// than one, because a plugin declares a single `targetType` (types.js) and the
// runner stamps it onto every context and member row it writes. A single plugin
// emitting both a principal-side and a resource-side tree would label the
// resource contexts `Principal`. Same mirror-pair shape as
// principal-type-tree / resource-type-tree — the algorithm lives here once.

import * as db from '../../db/connection.js';

export const ROOT_EXTERNAL_ID = 'system-root';

// Which table holds the members of each targetType. A fixed map, never
// caller-supplied, so the name is safe to interpolate into the query.
const MEMBER_TABLE = { Principal: 'Principals', Resource: 'Resources' };

// Every system LEFT JOINed to its (non-tombstoned) rows, so a system with no
// principals/resources still comes back — one row with a null memberId — and
// therefore still gets a context of its own.
export function buildSystemQuery(targetType) {
  const table = MEMBER_TABLE[targetType];
  if (!table) throw new Error(`Unsupported targetType: ${targetType}`);
  return `SELECT s.id AS "systemId", s."displayName" AS "systemName", m.id::text AS "memberId"
            FROM "Systems" s
            LEFT JOIN "${table}" m ON m."systemId" = s.id AND m."deletedAt" IS NULL
           ORDER BY s.id`;
}

// Fold the rows into the two-level tree: a synthetic root with one child
// context per system, each holding that system's rows as members.
//
// The child externalId is keyed on Systems.id, not on the name, so renaming a
// system reconciles as an in-place UPDATE (keeping analyst edits and grafted
// children) instead of a delete + recreate. A removed system simply stops
// appearing in the output and the runner deletes its context.
export function buildSystemTree(rows, { rootName, rootType, childType }) {
  const contexts = [{ externalId: ROOT_EXTERNAL_ID, displayName: rootName, contextType: rootType }];
  const members = [];
  const seen = new Set();
  for (const r of rows) {
    const ext = `system:${r.systemId}`;
    if (!seen.has(ext)) {
      seen.add(ext);
      contexts.push({
        externalId: ext,
        displayName: (r.systemName || '').trim() || `System ${r.systemId}`,
        contextType: childType,
        parentExternalId: ROOT_EXTERNAL_ID,
      });
    }
    if (r.memberId) members.push({ contextExternalId: ext, memberId: r.memberId });
  }
  return { contexts, members, systemCount: seen.size };
}

// The shared `run()` body. `defaults` carries the target-side naming
// (rootName / rootType / childType / noun) supplied by each plugin module.
export async function runSystemMembership(targetType, params, ctx, defaults) {
  const rootName = String((params && params.rootName) || defaults.rootName).slice(0, 500);

  const rows = (await db.query(buildSystemQuery(targetType))).rows;
  if (rows.length === 0) {
    ctx.log?.('No systems are connected — nothing to group.');
    return { contexts: [], members: [] };
  }

  const { contexts, members, systemCount } = buildSystemTree(rows, { ...defaults, rootName });
  ctx.log?.(`Grouped ${members.length} ${defaults.noun} into ${systemCount} system(s).`);
  return { contexts, members };
}
