// The matrix's "Proposed" lens — the reads behind it.
// Design: docs/architecture/m1-discovery-and-design.md, "Proposed roles in the matrix".
//
//   listAllInvestigations(db)          every saved investigation that holds a proposed role, any unit
//   proposedMatrixRows(db, principalIds) the matrix's own rows for these accounts — every access they
//                                      hold, in the shape GET /api/permissions answers — and which
//                                      business roles cover each cell (managedByPackages)
//
// The browser works out who each proposed role would reach (the workbench's own
// rule code, against the unit's current data) and asks for those accounts here;
// the proposals then become extra business-role bands over these rows. Read-only.

import { discoverGridColumns, shapeManagedByPackages } from '../../routes/permissions/gridQuery.js';
import { GROUP_PRINCIPAL_TYPE } from '../../lib/principalTypes.js';

export const MAX_PRINCIPALS = 2000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ProposedMatrixError extends Error {
  constructor(status, message) { super(message); this.name = 'ProposedMatrixError'; this.status = status; }
}

export const LIST_ALL_SQL = `
  SELECT w.id, w.name, w."contextId", c."displayName" AS "unitName", w."updatedBy", w."updatedAt",
         COALESCE((SELECT json_agg(json_build_object('id', p.id, 'name', p.name) ORDER BY p.position, p."createdAt", p.id)
                     FROM "RoleProposals" p WHERE p."investigationId" = w.id), '[]'::json) AS proposals
    FROM "WorkbenchInvestigations" w
    JOIN "Contexts" c ON c.id = w."contextId"
   WHERE EXISTS (SELECT 1 FROM "RoleProposals" p WHERE p."investigationId" = w.id)
   ORDER BY w."updatedAt" DESC, w.id`;

/** Every saved investigation with at least one proposed role, newest first, with its unit's name. */
export async function listAllInvestigations(db) {
  return (await db.query(LIST_ALL_SQL)).rows;
}

/** The account ids asked for: UUIDs, lower-cased, without duplicates, at most MAX_PRINCIPALS. Pure. */
export function parsePrincipalIds(value) {
  if (!Array.isArray(value)) throw new ProposedMatrixError(400, 'principalIds must be a list.');
  if (value.length > MAX_PRINCIPALS) throw new ProposedMatrixError(400, `At most ${MAX_PRINCIPALS} accounts.`);
  if (value.some(v => typeof v !== 'string' || !UUID_RE.test(v))) throw new ProposedMatrixError(400, 'principalIds holds something that is not an id.');
  return [...new Set(value.map(v => v.toLowerCase()))];
}

// The same columns and joins as the matrix feed (routes/permissions/gridQuery.js),
// narrowed to the accounts asked for.
export const rowsSql = (dynamicUserCols) => `
  SELECT p."resourceId" AS "resourceId", p."resourceId" AS "groupId",
         r."displayName" AS "resourceDisplayName", r."displayName" AS "groupDisplayName",
         r."resourceType", r."resourceType" AS "groupTypeCalculated",
         r."description" AS "resourceDescription", r."description" AS "groupDescription",
         r."systemId", sys."displayName" AS "systemName",
         p."principalId" AS "memberId", u."displayName" AS "memberDisplayName", u."email" AS "memberUPN",
         p."principalType" AS "memberType", p."membershipType",
         ${dynamicUserCols}
         p."managedByAccessPackage"
    FROM "vw_ResourceUserPermissionAssignments" p
    JOIN "Principals" u ON p."principalId" = u.id
    LEFT JOIN "Resources" r ON p."resourceId" = r.id
    LEFT JOIN "Systems" sys ON r."systemId" = sys.id
   WHERE p."principalId" = ANY($1::uuid[])
     AND (p."principalType" IS NULL OR p."principalType" != '${GROUP_PRINCIPAL_TYPE}')`;

export const COVERED_SQL = `
  SELECT ap."userId" AS "memberId", ap."resourceId", ap."resourceId" AS "groupId",
         string_agg(ap."businessRoleId"::text, ',') AS "accessPackageIds"
    FROM "vw_UserPermissionAssignmentViaBusinessRole" ap
   WHERE ap."userId" = ANY($1::uuid[])
   GROUP BY ap."userId", ap."resourceId"`;

/** The matrix rows of these accounts and the business roles that cover each of their cells. */
export async function proposedMatrixRows(db, body) {
  const ids = parsePrincipalIds(body?.principalIds);
  if (ids.length === 0) return { data: [], managedByPackages: [] };
  const pool = await db.getPool();
  const { dynamicUserCols } = await discoverGridColumns(pool);
  const [rows, covered] = await Promise.all([
    db.query(rowsSql(dynamicUserCols), [ids]),
    db.query(COVERED_SQL, [ids]),
  ]);
  return { data: rows.rows, managedByPackages: shapeManagedByPackages(covered.rows) };
}
