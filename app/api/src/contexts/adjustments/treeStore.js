// Loading one adjustable tree: the units its source puts in it, the units its
// adjustments added, and everything hanging under either.
//
// `runner` is anything with query(text, params) → { rows }: the db module or a
// transaction client.

import { parseTreeKey, baseUnitFilter } from './treeKey.js';

// Adjustments that bring a unit of their own into the tree.
export const CREATING_OPS = Object.freeze(['addUnit', 'splitUnit']);

export async function createdUnitIds(runner, treeKey) {
  const { rows } = await runner.query(`
    SELECT payload->>'contextId' AS id FROM "ContextTreeAdjustments"
     WHERE "treeKey" = $1 AND op = ANY($2::text[]) AND status <> 'reverted'
       AND payload ? 'contextId'
  `, [treeKey, CREATING_OPS]);
  return rows.map(r => r.id);
}

// Returns null for an unknown or malformed key, else
// { key, kind, parsed, units, byId, ids, targetType, contextCategory, systemId }.
// units: { id, parentId, rawParentId, name, variant, contextType, contextCategory,
// targetType, scopeSystemId, externalId, memberCount, totalMemberCount, ... } —
// parentId is null when the parent is outside the tree (a top-level unit).
export async function loadTree(runner, treeKey) {
  const parsed = parseTreeKey(treeKey);
  if (!parsed) return null;
  const created = await createdUnitIds(runner, treeKey);
  const base = baseUnitFilter(parsed, 1);
  const { rows } = await runner.query(`
    WITH RECURSIVE seed AS (
      SELECT c.id FROM "Contexts" c WHERE ${base.sql}
      UNION
      SELECT c.id FROM "Contexts" c WHERE c.id = ANY($1::uuid[])
    ), t AS (
      SELECT id FROM seed
      UNION
      SELECT c.id FROM "Contexts" c JOIN t ON c."parentContextId" = t.id
    )
    SELECT c.id, c."parentContextId" AS "rawParentId", c."displayName" AS name, c.variant,
           c."contextType", c."contextCategory", c."targetType", c."scopeSystemId",
           c."externalId", c."sourceAlgorithmId", c."sourceInstanceKey", c."extendedAttributes",
           c."directMemberCount" AS "memberCount", c."totalMemberCount", c."userRenamed", c."userReparented"
      FROM "Contexts" c JOIN t ON t.id = c.id
     ORDER BY c."displayName"
  `, [created, ...base.params]);
  if (rows.length === 0 && parsed.kind !== 'synced') return null;
  return shapeTree(treeKey, parsed, rows);
}

// Pure: derive the lookups and the tree-wide facts from the loaded rows.
export function shapeTree(key, parsed, rows) {
  const ids = new Set(rows.map(r => r.id));
  const units = rows.map(r => ({ ...r, parentId: ids.has(r.rawParentId) ? r.rawParentId : null }));
  const byId = new Map(units.map(u => [u.id, u]));
  const sourced = units.find(u => u.variant !== 'manual') || units[0];
  return {
    key, kind: parsed.kind, parsed, units, byId, ids,
    targetType: sourced?.targetType || 'Principal',
    contextCategory: sourced?.contextCategory || null,
    systemId: parsed.kind === 'synced' ? parsed.systemId : (sourced?.scopeSystemId ?? null),
  };
}

// Is `ancestorId` the unit itself or above `unitId`, by the in-memory parents?
export function isSelfOrAncestor(tree, ancestorId, unitId) {
  const seen = new Set();
  for (let id = unitId; id && !seen.has(id); id = tree.byId.get(id)?.parentId) {
    if (id === ancestorId) return true;
    seen.add(id);
  }
  return false;
}

// The member table for a tree's target type, to tell "left the source" apart.
export const MEMBER_TABLES = Object.freeze({ Principal: 'Principals', Identity: 'Identities', Resource: 'Resources' });
