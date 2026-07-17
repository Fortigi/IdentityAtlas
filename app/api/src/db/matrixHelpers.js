import { GROUP_PRINCIPAL_TYPE } from '../lib/principalTypes.js';

/**
 * Shared SQL expression builders for matrix.js.
 * Each function encapsulates a rowType === 'identity' ? ... : ... branch that
 * appeared 2-4 times across the matrix route handler.
 */

/** Preview and scope-stats assignment filter expressions (uses vw_ResourceUserPermissionAssignments alias p). */
// `subjectSql` / `resourceSql` are the already-rendered subquery fragments for
// this query (from built.subject(bind)/built.resource(bind)), so their $N line
// up with the caller's params array.
export function buildAssignmentExprs(rowType, subjectSql, resourceSql) {
  const subjectIdExpr = rowType === 'identity' ? 'im."identityId"' : 'p."principalId"';
  const assignmentJoin = rowType === 'identity'
    ? `INNER JOIN "IdentityMembers" im ON im."principalId" = p."principalId"`
    : '';
  const assignmentWhere = [`(p."principalType" IS NULL OR p."principalType" != '${GROUP_PRINCIPAL_TYPE}')`];
  if (subjectSql)  assignmentWhere.push(`${subjectIdExpr} IN ${subjectSql}`);
  if (resourceSql) assignmentWhere.push(`p."resourceId" IN ${resourceSql}`);
  return { subjectIdExpr, assignmentJoin, assignmentWhere };
}

/** Identity join expressions for context-rollup branches (source alias: nm.pid). */
export function buildIdentityJoinExprs(rowType) {
  const join = rowType === 'identity'
    ? `JOIN "IdentityMembers" im ON im."principalId" = nm.pid
       JOIN "Identities" i ON i.id = im."identityId"`
    : '';
  const subjectId = rowType === 'identity' ? 'i.id' : 'nm.pid';
  return { join, subjectId };
}

/** Subject join/id/name/type expressions for business-role drill (source: br."userId"). */
export function buildRoleSubjectJoinExprs(rowType) {
  const join = rowType === 'identity'
    ? `INNER JOIN "Principals" u ON u.id = br."userId"
       INNER JOIN "IdentityMembers" im ON im."principalId" = u.id
       INNER JOIN "Identities" i ON i.id = im."identityId"`
    : `INNER JOIN "Principals" u ON u.id = br."userId"`;
  return {
    join,
    id:   rowType === 'identity' ? 'i.id'             : 'u.id',
    name: rowType === 'identity' ? 'i."displayName"'  : 'u."displayName"',
    type: rowType === 'identity' ? `'Identity'`        : `'User'`,
  };
}

/** AP member id/join for rollup business-role count queries (source: br."userId"). */
export function buildApMemberExprs(rowType) {
  return {
    memberId: rowType === 'identity' ? 'im2."identityId"' : 'br."userId"',
    join:     rowType === 'identity'
      ? 'INNER JOIN "IdentityMembers" im2 ON im2."principalId" = br."userId"'
      : '',
  };
}

/** Merge base group totals with an inherited array, summing shared groupValues. */
export function mergeGroupTotals(base, inherited) {
  if (!inherited?.length) return base;
  const m = new Map(base.map(t => [t.groupValue, t.total]));
  for (const t of inherited) m.set(t.groupValue, (m.get(t.groupValue) || 0) + t.total);
  return [...m.entries()].map(([groupValue, total]) => ({ groupValue, total }));
}

/** Extract the standard resource-metadata shape from a query row. */
export function resourceMeta(row) {
  return {
    resourceId:          row.resourceId,
    resourceDisplayName: row.resourceDisplayName,
    resourceType:        row.resourceType,
    resourceDescription: row.resourceDescription,
    systemId:            row.systemId,
    systemName:          row.systemName,
  };
}
