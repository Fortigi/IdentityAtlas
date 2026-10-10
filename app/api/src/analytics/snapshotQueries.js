// SQL for the current-state ("snapshot", historyMethod 'current') metrics.
//
// Each builder takes resolved dimensions — [{ field, dimension }] where `field`
// is a fields.js definition and `dimension` the profile's entry (label, unknown
// label) — plus the profile scope and a `bind`, and returns the statement text.
// Every statement is ONE GROUP BY over all of the dataset's dimensions at once:
// the joint distribution, not a set of marginal totals. Empty cells are never
// emitted (HAVING > 0), and LIMIT maxRows + 1 lets the caller refuse an
// oversized result instead of truncating it.
//
// Definitions: docs/architecture/analytics-profiles.md §4.

import { visibleResourceTypesSql } from '../lib/resourceVisibility.js';
import { GROUP_PRINCIPAL_TYPE } from '../lib/principalTypes.js';
import {
  IDENTITY_MAP_CTE, IDENTITY_JOINS, liveAccountWhere, dimensionSql, groupingClauses,
} from './sqlParts.js';

const usesIdentity = dims => dims.some(d => d.field.entity === 'Identity');

function grouping(dims, bind, viaAccount = true) {
  return groupingClauses(dims.map(({ field, dimension }) => dimensionSql({ field, dimension, bind, viaAccount })));
}

// principals.count — one live, non-group account in scope, counted once.
export function principalsCountSql({ dims, scope, maxRows, bind }) {
  const g = grouping(dims, bind);
  const identity = usesIdentity(dims);
  return `WITH ${IDENTITY_MAP_CTE}
  SELECT ${g.select}
         COUNT(*)::int AS accounts
    FROM "Principals" p
    ${identity ? IDENTITY_JOINS : ''}
   WHERE ${liveAccountWhere(scope, bind)}
   ${g.groupBy}
  HAVING COUNT(*) > 0
   ${g.orderBy}
   LIMIT ${bind(maxRows + 1)}`;
}

// The identities that have at least one live account in scope.
function liveIdentitiesCte(scope, bind) {
  return `live AS (
    SELECT DISTINCT im."identityId"
      FROM "IdentityMembers" im
      JOIN "Principals" p ON p."id" = im."principalId"
     WHERE ${liveAccountWhere(scope, bind)}
  )`;
}

// identities.count — one identity with a live account, counted once however
// many accounts it has. Identity fields only (validated upstream).
export function identitiesCountSql({ dims, scope, maxRows, bind }) {
  const g = grouping(dims, bind, false);
  return `WITH ${liveIdentitiesCte(scope, bind)}
  SELECT ${g.select}
         COUNT(*)::int AS identities
    FROM "Identities" i
    JOIN live l ON l."identityId" = i."id"
   ${g.groupBy}
  HAVING COUNT(*) > 0
   ${g.orderBy}
   LIMIT ${bind(maxRows + 1)}`;
}

// Identities NOT counted by identities.count: without scope, every identity with
// no live account; with scope, those linked to an in-scope account but with no
// live one.
export function identitiesExcludedSql({ scope, bind }) {
  const live = liveIdentitiesCte(scope, bind);
  if (!scope?.systemIds) {
    return `WITH ${live}
    SELECT COUNT(*)::int AS "identitiesWithoutLiveAccount"
      FROM "Identities" i
     WHERE NOT EXISTS (SELECT 1 FROM live l WHERE l."identityId" = i."id")`;
  }
  return `WITH ${live}
    SELECT COUNT(DISTINCT im."identityId")::int AS "identitiesWithoutLiveAccount"
      FROM "IdentityMembers" im
      JOIN "Principals" p ON p."id" = im."principalId"
     WHERE p."systemId" = ANY(${bind(scope.systemIds)}::int[])
       AND NOT EXISTS (SELECT 1 FROM live l WHERE l."identityId" = im."identityId")`;
}

// Distinct (account, resource) pairs of the matrix view, each flagged governed
// when a held business role covers it — the scope-statistics definition
// (routes/matrix/scope.js). The matview already drops tombstones.
const PAIRS_CTE = `pairs AS (
    SELECT v."principalId" AS pid, v."resourceId" AS rid,
           bool_or(br."userId" IS NOT NULL) AS governed
      FROM "vw_ResourceUserPermissionAssignments" v
      LEFT JOIN "vw_UserPermissionAssignmentViaBusinessRole" br
        ON br."userId" = v."principalId" AND br."resourceId" = v."resourceId"
     GROUP BY v."principalId", v."resourceId"
  )`;

// assignments.governedShare — numerator, denominator and holders per cell.
export function governedShareSql({ dims, scope, maxRows, bind }) {
  const g = grouping(dims, bind);
  const identity = usesIdentity(dims);
  return `WITH ${PAIRS_CTE}${identity ? `, ${IDENTITY_MAP_CTE}` : ''}
  SELECT ${g.select}
         COUNT(*)::int AS pairs,
         COUNT(*) FILTER (WHERE pr.governed)::int AS "governedPairs",
         COUNT(DISTINCT pr.pid)::int AS holders
    FROM pairs pr
    JOIN "Principals" p ON p."id" = pr.pid
    JOIN "Resources" r ON r."id" = pr.rid
    ${identity ? IDENTITY_JOINS : ''}
   WHERE ${liveAccountWhere(scope, bind)}
     AND ${visibleResourceTypesSql('r."resourceType"')}
   ${g.groupBy}
  HAVING COUNT(*) > 0
   ${g.orderBy}
   LIMIT ${bind(maxRows + 1)}`;
}

// What governedShare leaves out of its denominator, reported alongside it:
// pairs on default-hidden resource types (BusinessRole) and pairs held by group
// principals. Same scope as the dataset.
export function governedExcludedSql({ scope, bind }) {
  const scopeWhere = scope?.systemIds ? `WHERE p."systemId" = ANY(${bind(scope.systemIds)}::int[])` : '';
  return `SELECT
      COUNT(*) FILTER (WHERE NOT ${visibleResourceTypesSql('r."resourceType"')})::int AS "hiddenResourceTypePairs",
      COUNT(*) FILTER (WHERE p."principalType" = ${bind(GROUP_PRINCIPAL_TYPE)})::int AS "groupHolderPairs"
    FROM (SELECT DISTINCT "principalId", "resourceId" FROM "vw_ResourceUserPermissionAssignments") v
    JOIN "Principals" p ON p."id" = v."principalId"
    JOIN "Resources" r ON r."id" = v."resourceId"
    ${scopeWhere}`;
}
