// Context-tree roll-up: aggregate the matrix subject axis by a Context hierarchy
// (e.g. the Manager Hierarchy) instead of a flat attribute. Columns are the
// context nodes of the current "frontier" (a horizontal cut of the tree); each
// cell counts the in-scope subjects in that node's WHOLE SUBTREE who hold the
// resource. Clicking a column replaces it with its child nodes (drill one level
// deeper on that branch); leaf nodes expand into individuals.
//
// All builders are pure functions of validated inputs so they can be unit
// tested without a database. Context ids are always UUID-validated before they
// reach a query — they're embedded as a VALUES list (Postgres can't parameterise
// a VALUES-list of arbitrary length cleanly), so validation is the safety net.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

// Turn a list of UUIDs into a Postgres VALUES body: ('a'::uuid),('b'::uuid).
// Throws if any id isn't a UUID — callers should 400 on the thrown error.
export function frontierValues(ids) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('empty frontier');
  for (const id of ids) {
    if (!isUuid(id)) throw new Error('invalid context id');
  }
  return ids.map(id => `('${id}'::uuid)`).join(', ');
}

// Quoted, UUID-validated id list for `IN (...)` clauses.
function idList(ids) {
  return ids.map(id => `'${id}'::uuid`).join(', ');
}

// The recursive subtree CTE shared by the cell + denominator queries: for each
// frontier node, every descendant context id (including the node itself), then
// the distinct member principal of each subtree.
function subtreeCte(values) {
  return `
    WITH RECURSIVE frontier(fid) AS ( VALUES ${values} ),
    subtree(frontier_id, ctx_id) AS (
      SELECT fid, fid FROM frontier
      UNION ALL
      SELECT s.frontier_id, c.id
        FROM "Contexts" c
        JOIN subtree s ON c."parentContextId" = s.ctx_id
    ),
    node_members AS (
      SELECT DISTINCT s.frontier_id AS fid, cm."memberId" AS pid
        FROM subtree s
        JOIN "ContextMembers" cm ON cm."contextId" = s.ctx_id
       WHERE cm."memberType" = 'Principal'
    )`;
}

// Cells: distinct in-scope subjects per (resource, frontier node) with a Direct
// assignment, plus the governed subset — mirrors buildRollupSql's shape so the
// frontend renders it the same way.
//   identityJoin   '' for principals, or the IdentityMembers/Identities join
//   subjectId      the distinct-counted subject expr ('nm.pid' or 'i.id')
//   subjectScope   IN-clause target for the subject filter (same expr)
export function buildContextRollupSql({ values, identityJoin = '', subjectId, subjectScope, subjectSql, resourceSql }) {
  const where = [
    `(p."principalType" IS NULL OR p."principalType" != '#microsoft.graph.group')`,
    `p."membershipType" = 'Direct'`,
  ];
  if (subjectSql)  where.push(`${subjectScope} IN ${subjectSql}`);
  if (resourceSql) where.push(`p."resourceId" IN ${resourceSql}`);
  return `${subtreeCte(values)}
    SELECT p."resourceId"          AS "resourceId",
           r."displayName"         AS "resourceDisplayName",
           r."resourceType"        AS "resourceType",
           r."description"         AS "resourceDescription",
           r."systemId"            AS "systemId",
           sys."displayName"       AS "systemName",
           nm.fid::text            AS "groupValue",
           COUNT(DISTINCT ${subjectId})::int AS "directCount",
           COUNT(DISTINCT ${subjectId}) FILTER (WHERE br."userId" IS NOT NULL)::int AS "governedCount"
      FROM node_members nm
      ${identityJoin}
      JOIN "vw_ResourceUserPermissionAssignments" p ON p."principalId" = nm.pid
      LEFT JOIN "Resources" r   ON p."resourceId" = r.id
      LEFT JOIN "Systems"  sys  ON r."systemId" = sys.id
      LEFT JOIN "vw_UserPermissionAssignmentViaBusinessRole" br
        ON br."userId" = p."principalId" AND br."resourceId" = p."resourceId"
     WHERE ${where.join(' AND ')}
     GROUP BY p."resourceId", r."displayName", r."resourceType", r."description", r."systemId", sys."displayName", nm.fid`;
}

// Per-node subject denominator for the "% of subjects" metric: distinct in-scope
// subjects in each frontier node's subtree (independent of any resource).
export function buildContextTotalsSql({ values, identityJoin = '', subjectId, subjectScope, subjectSql }) {
  const where = [];
  if (subjectSql) where.push(`${subjectScope} IN ${subjectSql}`);
  return `${subtreeCte(values)}
    SELECT nm.fid::text AS "groupValue",
           COUNT(DISTINCT ${subjectId})::int AS "total"
      FROM node_members nm
      ${identityJoin}
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     GROUP BY nm.fid`;
}

// Frontier node metadata (display name, subtree size, whether it can drill).
export function buildContextNodesSql(ids) {
  return `
    SELECT c.id::text AS id, c."displayName" AS "displayName",
           c."parentContextId"::text AS parent,
           c."totalMemberCount" AS total,
           (SELECT COUNT(*)::int FROM "Contexts" g WHERE g."parentContextId" = c.id) AS "childCount"
      FROM "Contexts" c
     WHERE c.id IN (${idList(ids)})`;
}

// Children of every frontier node — lets the frontend drill (replace a node with
// its children) without an extra round-trip. Ordered biggest subtree first.
export function buildContextChildrenSql(ids) {
  return `
    SELECT c."parentContextId"::text AS parent, c.id::text AS id,
           c."displayName" AS "displayName", c."totalMemberCount" AS total,
           (SELECT COUNT(*)::int FROM "Contexts" g WHERE g."parentContextId" = c.id) AS "childCount"
      FROM "Contexts" c
     WHERE c."parentContextId" IN (${idList(ids)})
     ORDER BY c."totalMemberCount" DESC, c."displayName"`;
}

// Default frontier when none is supplied: the children of the chosen root, or
// the root itself if it's a leaf.
export function buildRootChildrenSql(rootId) {
  if (!isUuid(rootId)) throw new Error('invalid context id');
  return `SELECT id::text AS id FROM "Contexts" WHERE "parentContextId" = '${rootId}'::uuid ORDER BY "totalMemberCount" DESC`;
}
