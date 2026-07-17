import { GROUP_PRINCIPAL_TYPE } from '../lib/principalTypes.js';

// Layered ATTRIBUTE fold — the efficient, server-aggregated counterpart of the
// per-subject attribute fold. Instead of shipping every subject row (which
// overflows JSON serialization for large sets), we aggregate on the server:
// columns are attribute-value tuples of the current "cut" of the fold tree, and
// each cell counts the in-scope subjects in that tuple with a Direct assignment.
// Expanding a tuple replaces it with the distinct values of the next fold
// attribute — exactly like the Manager-Hierarchy layered view, but the tree is
// the sequence of sort attributes rather than a Context hierarchy.
//
// All builders are pure functions of validated inputs (attribute expressions are
// produced by resolveAttrExpr; expanded keys are bound as parameters) so they
// can be unit-tested without a database.

// Unit separator joins attribute values into a tuple key — vanishingly unlikely
// to occur inside a value, and never typed by a user. In SQL it is emitted as
// chr(31) (never a literal control char in the query text); in JS, keys are
// split on the matching code point.
export const TUPLE_SEP = String.fromCharCode(31);
const SQL_SEP = 'chr(31)';

// COALESCE'd, empty-as-(none) text for one attribute expression.
function val(expr) {
  return `COALESCE(NULLIF(${expr}::text, ''), '(none)')`;
}

// Prefix-key expressions k1..kN, where k_d = v1 || SEP || ... || v_d.
function prefixKeys(attrExprs) {
  const keys = [];
  for (let d = 0; d < attrExprs.length; d++) {
    keys.push(d === 0 ? val(attrExprs[0]) : `${keys[d - 1]} || ${SQL_SEP} || ${val(attrExprs[d])}`);
  }
  return keys;
}

// The per-subject "visible key", COLLAPSE model: a subject is shown at the full
// tuple depth by DEFAULT (so all chosen attributes appear as header rows), and a
// folded group pulls its subjects up to that level — the subject stops at the
// first prefix that is in the collapsed set. collapsedParams are bound
// placeholder names (e.g. ['@col0','@col1']); empty = nothing folded = full depth.
export function visibleKeyExpr(attrExprs, collapsedParams = []) {
  const keys = prefixKeys(attrExprs);
  const deepest = keys[keys.length - 1];
  if (!collapsedParams.length || keys.length === 1) return deepest; // full depth
  const inList = `(${collapsedParams.join(', ')})`;
  const whens = [];
  for (let d = 0; d < keys.length - 1; d++) {
    whens.push(`WHEN ${keys[d]} IN ${inList} THEN ${keys[d]}`);
  }
  return `CASE ${whens.join(' ')} ELSE ${deepest} END`;
}

// The (depth+1)-th attribute value for a subject — the value its visible tuple
// would split into if expanded. NULL once the visible tuple is at the deepest
// attribute (so the tuple is a leaf and not expandable).
function nextValExpr(attrExprs, vkExpr) {
  if (attrExprs.length <= 1) return 'NULL';
  const depth = `array_length(string_to_array(${vkExpr}, ${SQL_SEP}), 1)`;
  const whens = [];
  for (let d = 1; d < attrExprs.length; d++) whens.push(`WHEN ${d} THEN ${val(attrExprs[d])}`);
  return `CASE ${depth} ${whens.join(' ')} ELSE NULL END`;
}

// Cells: distinct in-scope subjects per (resource, visible tuple) with a Direct
// assignment, plus the governed subset — mirrors buildRollupSql's shape so the
// frontend renders it identically.
export function buildAttrCutCellsSql({ attrExprs, collapsedParams = [], subjectJoin, subjectIdExpr, subjectIdForFilter, subjectSql, resourceSql }) {
  const where = [
    `(p."principalType" IS NULL OR p."principalType" != '${GROUP_PRINCIPAL_TYPE}')`,
    `p."membershipType" = 'Direct'`,
  ];
  if (subjectSql)  where.push(`${subjectIdForFilter} IN ${subjectSql}`);
  if (resourceSql) where.push(`p."resourceId" IN ${resourceSql}`);
  const vk = visibleKeyExpr(attrExprs, collapsedParams);
  return `
    SELECT t."resourceId"          AS "resourceId",
           t."resourceDisplayName" AS "resourceDisplayName",
           t."resourceType"        AS "resourceType",
           t."resourceDescription" AS "resourceDescription",
           t."systemId"            AS "systemId",
           t."systemName"          AS "systemName",
           t."groupValue"          AS "groupValue",
           COUNT(*)::int                          AS "directCount",
           COUNT(*) FILTER (WHERE t.governed)::int AS "governedCount"
      FROM (
        SELECT p."resourceId"      AS "resourceId",
               r."displayName"     AS "resourceDisplayName",
               r."resourceType"    AS "resourceType",
               r."description"     AS "resourceDescription",
               r."systemId"        AS "systemId",
               sys."displayName"   AS "systemName",
               ${vk}               AS "groupValue",
               ${subjectIdExpr}    AS sid,
               bool_or(br."userId" IS NOT NULL) AS governed
          FROM "vw_ResourceUserPermissionAssignments" p
          ${subjectJoin}
          LEFT JOIN "Resources" r   ON p."resourceId" = r.id
          LEFT JOIN "Systems"  sys  ON r."systemId" = sys.id
          LEFT JOIN "vw_UserPermissionAssignmentViaBusinessRole" br
            ON br."userId" = p."principalId" AND br."resourceId" = p."resourceId"
         WHERE ${where.join(' AND ')}
         GROUP BY p."resourceId", r."displayName", r."resourceType", r."description",
                  r."systemId", sys."displayName", ${vk}, ${subjectIdExpr}
      ) t
     GROUP BY t."resourceId", t."resourceDisplayName", t."resourceType",
              t."resourceDescription", t."systemId", t."systemName", t."groupValue"`;
}

// Frontier metadata: per visible tuple, the distinct in-scope subject total and
// how many distinct next-attribute values it would split into (childCount = 0 ->
// a leaf, can't expand). For principals the group-shaped accounts are excluded
// so the totals match what the matrix renders.
export function buildAttrCutNodesSql({ attrExprs, collapsedParams = [], subjectTable, subjectAlias, subjectIdExpr, subjectIdForFilter, subjectSql, excludeGroups }) {
  const vk = visibleKeyExpr(attrExprs, collapsedParams);
  const nv = nextValExpr(attrExprs, vk);
  const where = [];
  if (excludeGroups) where.push(`${subjectAlias}."principalType" != '${GROUP_PRINCIPAL_TYPE}'`);
  if (subjectSql)    where.push(`${subjectIdForFilter} IN ${subjectSql}`);
  return `
    SELECT s.gk AS "groupValue",
           COUNT(DISTINCT s.sid)::int AS "total",
           COUNT(DISTINCT s.nv)::int  AS "childCount"
      FROM (
        SELECT ${subjectIdExpr} AS sid, ${vk} AS gk, ${nv} AS nv
          FROM "${subjectTable}" ${subjectAlias}
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ) s
     GROUP BY s.gk`;
}

// Turn a visible-tuple key back into the layered-render node shape the frontend
// already consumes for the Manager-Hierarchy view: ancestor path (= the tuple
// values) + depth + display name (the deepest value).
export function tupleToNode(groupValue, total, childCount) {
  const pathNames = String(groupValue).split(TUPLE_SEP);
  return {
    id: groupValue,
    depth: pathNames.length,
    pathIds: pathNames,        // value tuple doubles as its own id path
    pathNames,
    displayName: pathNames[pathNames.length - 1],
    total: total || 0,
    directMembers: 0,          // no "direct people at this node" concept for attributes
    childCount: childCount || 0,
  };
}
