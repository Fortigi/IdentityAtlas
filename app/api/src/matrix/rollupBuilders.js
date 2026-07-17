import { GROUP_PRINCIPAL_TYPE } from '../lib/principalTypes.js';

// Pure SQL builders for the matrix roll-up aggregations.
//
// Extracted verbatim from routes/matrix.js as part of splitting that god-module
// (audit finding Q1). Each function is pure: it takes pre-built SQL fragments /
// expressions and returns a SQL string — no DB access, no module state. They are
// re-exported from routes/matrix.js so existing imports (matrix.rollup.test.js)
// keep working.

// Pure builder for the roll-up aggregation: count DISTINCT subjects with a
// Direct assignment, grouped by (resource, attribute value). Direct only —
// Indirect/Owner/Eligible are intentionally ignored. Exported for unit tests.
export function buildRollupSql({ attrExpr, subjectJoin, subjectIdExpr, subjectIdForFilter, subjectSql, resourceSql }) {
  const where = [
    `(p."principalType" IS NULL OR p."principalType" != '${GROUP_PRINCIPAL_TYPE}')`,
    `p."membershipType" = 'Direct'`,
  ];
  if (subjectSql)  where.push(`${subjectIdForFilter} IN ${subjectSql}`);
  if (resourceSql) where.push(`p."resourceId" IN ${resourceSql}`);
  const grp = `COALESCE(NULLIF(${attrExpr}::text, ''), '(none)')`;
  // Inner: one row per distinct subject per (resource, group) with a governed
  // flag (covered by a business role). Outer: count subjects, and the subset
  // that's governed — so the view's All / Governed / Non-governed toggle can
  // pick the right number without a re-query.
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
               ${grp}              AS "groupValue",
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
                  r."systemId", sys."displayName", ${grp}, ${subjectIdExpr}
      ) t
     GROUP BY t."resourceId", t."resourceDisplayName", t."resourceType",
              t."resourceDescription", t."systemId", t."systemName", t."groupValue"
  `;
}

// Pure builder for the roll-up business-role (SOLL) counts: distinct in-scope
// subjects holding each resource via each business role. Exported for tests.
export function buildRollupRolesSql({ brMemberId, brJoin, subjectSql, resourceSql }) {
  const where = [];
  if (subjectSql)  where.push(`${brMemberId} IN ${subjectSql}`);
  if (resourceSql) where.push(`br."resourceId" IN ${resourceSql}`);
  return `
    SELECT br."resourceId"     AS "resourceId",
           br."businessRoleId" AS "roleId",
           role."displayName"  AS "roleName",
           COUNT(DISTINCT ${brMemberId})::int AS "count"
      FROM "vw_UserPermissionAssignmentViaBusinessRole" br
      ${brJoin}
      LEFT JOIN "Resources" role ON role.id = br."businessRoleId"
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     GROUP BY br."resourceId", br."businessRoleId", role."displayName"
  `;
}

// Pure builder for the "business roles only" roll-up: business roles on the
// rows, roll-up attribute values on the columns, each cell the count of distinct
// in-scope subjects who hold that role. Resources are not involved here.
// Exported for unit tests.
export function buildRolesAsRowsSql({ attrExpr, subjectJoin, subjectIdExpr, subjectIdForFilter, subjectSql }) {
  const where = [];
  if (subjectSql) where.push(`${subjectIdForFilter} IN ${subjectSql}`);
  const grp = `COALESCE(NULLIF(${attrExpr}::text, ''), '(none)')`;
  return `
    SELECT br."businessRoleId" AS "roleId",
           role."displayName"  AS "roleName",
           role."description"  AS "roleDescription",
           ${grp}              AS "groupValue",
           COUNT(DISTINCT ${subjectIdExpr})::int AS "count"
      FROM "vw_UserPermissionAssignmentViaBusinessRole" br
      ${subjectJoin}
      LEFT JOIN "Resources" role ON role.id = br."businessRoleId"
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     GROUP BY br."businessRoleId", role."displayName", role."description", ${grp}
  `;
}

// Per-group subject denominator for the roll-up "% of subjects" metric: the
// count of distinct in-scope subjects in each attribute group, independent of
// any resource or role. For principals the group-shaped accounts are excluded
// so the denominator matches what the matrix renders. Exported for unit tests.
export function buildGroupTotalsSql({ attrExpr, subjectTable, subjectAlias, subjectSql }) {
  const where = [];
  if (subjectTable === 'Principals') {
    where.push(`(${subjectAlias}."principalType" IS NULL OR ${subjectAlias}."principalType" != '${GROUP_PRINCIPAL_TYPE}')`);
  }
  if (subjectSql) where.push(`${subjectAlias}.id IN ${subjectSql}`);
  const grp = `COALESCE(NULLIF(${attrExpr}::text, ''), '(none)')`;
  return `
    SELECT ${grp} AS "groupValue",
           COUNT(DISTINCT ${subjectAlias}.id)::int AS "total"
      FROM "${subjectTable}" ${subjectAlias}
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     GROUP BY ${grp}
  `;
}

// Roles-only drill-down: the individual subjects (already scoped to one group
// via a subject attribute condition baked into subjectSql) and which business
// role each one holds. Powers expanding a group column into its subjects when
// business roles are the rows. Exported for unit tests.
export function buildRolesDrillSql({ subjectJoin, subjectIdExpr, subjectNameExpr, subjectTypeExpr, subjectIdForFilter, subjectSql }) {
  const where = [];
  if (subjectSql) where.push(`${subjectIdForFilter} IN ${subjectSql}`);
  return `
    SELECT DISTINCT ${subjectIdExpr}  AS "memberId",
           ${subjectNameExpr}         AS "memberDisplayName",
           ${subjectTypeExpr}         AS "memberType",
           br."businessRoleId"        AS "roleId"
      FROM "vw_UserPermissionAssignmentViaBusinessRole" br
      ${subjectJoin}
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
  `;
}
