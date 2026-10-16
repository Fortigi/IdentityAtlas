// Organisation truth — the entity detail page's fan-out graph
// (GET /org-truth/entities/:id/graph[?category=<key>]), in the node shapes
// app/ui/src/components/entityGraphShape.js uses.
//
// Without ?category:
//   { core: { id, entityType, displayName,
//             counts: { relationsOut, relationsIn, links,
//                       bySystemType: { Principal, Resource, Identity, Context } } },
//     categories: [ { key, label, count, kind: 'category' } ] }
//   categories, in this order:
//     rel:out:<predicate>   label "<predicate> →"   one per outgoing predicate (alphabetical)
//     rel:in:<predicate>    label "← <predicate>"   one per incoming predicate (alphabetical)
//     link:<targetType>     Accounts | Resources | Identities | Contexts | Other lists (only types with links)
//
// With ?category=<key>:
//   { items: [ { key, label, kind: 'item', entityKind, entityId, status, … } ] }
//   rel:*   → entityKind 'org-entity' (+ entityType)              key 'org-entity:<id>'
//   link:*  → entityKind 'user' (Principal), 'resource' (Resource; 'access-package'
//             for a BusinessRole), 'identity', 'context'           key '<entityKind>:<id>'
//             (+ confidence, resourceType for Resources)
//   at most MAX_ITEMS items; the UI caps the ring itself.
//
// The graph shows the live picture: rejected and closed relations and rejected
// links (status or analyst override) are left out; proposed ones stay in, with
// their status on the item. The detail endpoint shows everything.
import * as db from '../../db/connection.js';
import { LINK_TARGETS } from '../contracts.js';
import { resolveLabels } from './entities.js';

export const MAX_ITEMS = 500;
export const LINK_LABELS = { Principal: 'Accounts', Resource: 'Resources', Identity: 'Identities', Context: 'Contexts', OrgEntity: 'Other lists' };
const ENTITY_KIND = { Principal: 'user', Resource: 'resource', Identity: 'identity', Context: 'context', OrgEntity: 'org-entity' };
const SYSTEM_TYPES = Object.keys(LINK_TARGETS);

const LIVE_RELATION = `r.status <> 'rejected' AND r."validTo" IS NULL`;
const LIVE_LINK = `l.status <> 'rejected' AND l."analystOverride" IS DISTINCT FROM 'rejected'`;

/** 'rel:out:owner' → { kind: 'rel', direction: 'out', predicate: 'owner' }; null when not a category key. */
export function parseCategory(key) {
  if (typeof key !== 'string') return null;
  const rel = /^rel:(out|in):(.+)$/s.exec(key);
  if (rel) return { kind: 'rel', direction: rel[1], predicate: rel[2] };
  const link = /^link:(\w+)$/.exec(key);
  if (link && SYSTEM_TYPES.includes(link[1])) return { kind: 'link', targetType: link[1] };
  return null;
}

async function loadCoreRow(id) {
  const r = await db.query(
    `SELECT id, "entityType", "displayName" FROM "OrgEntities" WHERE id = $1`,
    [id],
  );
  return r.rows[0] || null;
}

async function relationCounts(id) {
  return (await db.query(`
    SELECT CASE WHEN r."fromEntityId" = $1 THEN 'out' ELSE 'in' END AS direction,
           r.predicate, COUNT(*)::int AS n
      FROM "OrgRelations" r
     WHERE (r."fromEntityId" = $1 OR r."toEntityId" = $1) AND ${LIVE_RELATION}
     GROUP BY 1, 2
  `, [id])).rows;
}

async function linkCounts(id) {
  return (await db.query(`
    SELECT l."targetType", COUNT(*)::int AS n
      FROM "OrgLinks" l
     WHERE l."orgEntityId" = $1 AND ${LIVE_LINK}
     GROUP BY l."targetType"
  `, [id])).rows;
}

function relationCategories(rows, direction) {
  return rows
    .filter(r => r.direction === direction)
    .sort((a, b) => a.predicate.localeCompare(b.predicate))
    .map(r => ({
      key: `rel:${direction}:${r.predicate}`,
      label: direction === 'out' ? `${r.predicate} →` : `← ${r.predicate}`,
      count: r.n,
      kind: 'category',
    }));
}

export function shapeGraphCore(entity, relRows, linkRows) {
  const bySystemType = Object.fromEntries(SYSTEM_TYPES.map(t => [t, 0]));
  for (const r of linkRows) bySystemType[r.targetType] = r.n;
  const total = (dir) => relRows.filter(r => r.direction === dir).reduce((n, r) => n + r.n, 0);
  const core = {
    id: entity.id,
    entityType: entity.entityType,
    displayName: entity.displayName,
    counts: {
      relationsOut: total('out'),
      relationsIn: total('in'),
      links: linkRows.reduce((n, r) => n + r.n, 0),
      bySystemType,
    },
  };
  const linkCategories = SYSTEM_TYPES
    .filter(t => bySystemType[t] > 0)
    .map(t => ({ key: `link:${t}`, label: LINK_LABELS[t], count: bySystemType[t], kind: 'category' }));
  return { core, categories: [...relationCategories(relRows, 'out'), ...relationCategories(relRows, 'in'), ...linkCategories] };
}

// Two fixed statements; the direction picks one, the predicate is bound.
const REL_ITEMS_SQL = {
  out: `SELECT o.id, o."displayName", o."entityType", r.status
          FROM "OrgRelations" r JOIN "OrgEntities" o ON o.id = r."toEntityId"
         WHERE r."fromEntityId" = $1 AND r.predicate = $2 AND ${LIVE_RELATION}
         ORDER BY lower(o."displayName"), o.id LIMIT ${MAX_ITEMS}`,
  in:  `SELECT o.id, o."displayName", o."entityType", r.status
          FROM "OrgRelations" r JOIN "OrgEntities" o ON o.id = r."fromEntityId"
         WHERE r."toEntityId" = $1 AND r.predicate = $2 AND ${LIVE_RELATION}
         ORDER BY lower(o."displayName"), o.id LIMIT ${MAX_ITEMS}`,
};

async function relationItems(id, { direction, predicate }) {
  const r = await db.query(REL_ITEMS_SQL[direction], [id, predicate]);
  return r.rows.map(o => ({
    key: `org-entity:${o.id}`,
    label: o.displayName,
    kind: 'item',
    entityKind: 'org-entity',
    entityId: o.id,
    entityType: o.entityType,
    status: o.status,
  }));
}

export function linkItem(link, found) {
  const resourceType = found?.resourceType;
  const entityKind = resourceType === 'BusinessRole' ? 'access-package' : ENTITY_KIND[link.targetType];
  const item = {
    key: `${entityKind}:${link.targetId}`,
    label: found?.label || link.targetId,
    kind: 'item',
    entityKind,
    entityId: link.targetId,
    status: link.status,
    confidence: link.confidence,
  };
  if (resourceType) item.resourceType = resourceType;
  return item;
}

async function linkItems(id, { targetType }) {
  const r = await db.query(`
    SELECT l."targetType", l."targetId", l.confidence, l.status
      FROM "OrgLinks" l
     WHERE l."orgEntityId" = $1 AND l."targetType" = $2 AND ${LIVE_LINK}
     ORDER BY l.confidence DESC, l."targetId"
     LIMIT ${MAX_ITEMS}
  `, [id, targetType]);
  const labels = await resolveLabels(r.rows);
  return r.rows.map(l => linkItem(l, labels.get(`${l.targetType}:${l.targetId}`)));
}

/** The core + first-ring categories; null when the entity is unknown. */
export async function getEntityGraph(id) {
  const entity = await loadCoreRow(id);
  if (!entity) return null;
  const relRows = await relationCounts(id);
  const linkRows = await linkCounts(id);
  return shapeGraphCore(entity, relRows, linkRows);
}

/** The items of one category; null when the entity is unknown. `category` comes from parseCategory. */
export async function getGraphCategory(id, category) {
  const entity = await loadCoreRow(id);
  if (!entity) return null;
  const items = category.kind === 'rel' ? await relationItems(id, category) : await linkItems(id, category);
  return { items };
}
