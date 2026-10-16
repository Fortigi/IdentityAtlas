// Identity Atlas Interviews — what the consultant sees before the interview starts.
//
// One subject (the person interviewed, an Identity) and one team scope (a Context of
// people). For the scope: its members, each with a count of the access they hold, and
// the resources the team holds most widely. Read-only; nothing here writes.
//
// Set-based on purpose: the identity detail helpers (routes/identities/detailData.js)
// count one person per query, which for a 200-person team is 200 round trips. The
// counting rule is the same one — live assignments on live accounts, ownership rows
// (lib/ownershipTypes.js) excluded — expressed once for the whole team.
//
// Capped, never silently (decision-principles B2): members and resources each carry a
// `truncated` flag and the total, and the entity search reaches anyone outside the cap.

import { OWNERSHIP_TYPES_SQL } from '../lib/ownershipTypes.js';

export const MAX_MEMBERS = 200;
export const MAX_RESOURCES = 50;

const SCOPE_CTE = `WITH RECURSIVE scope AS (
    SELECT c."id" FROM "Contexts" c WHERE c."id" = $1::uuid
    UNION
    SELECT c."id" FROM "Contexts" c JOIN scope s ON c."parentContextId" = s."id"
  )`;

// The team's accounts: Principal members directly, Identity members through their accounts.
const TEAM_PRINCIPALS = `team_principals AS (
    SELECT DISTINCT p."id", m."personId"
      FROM (
        SELECT cm."memberId" AS "principalId", COALESCE(im."identityId", cm."memberId") AS "personId"
          FROM "ContextMembers" cm JOIN scope s ON s."id" = cm."contextId"
          LEFT JOIN "IdentityMembers" im ON im."principalId" = cm."memberId"
         WHERE cm."memberType" = 'Principal'
        UNION
        SELECT im."principalId", cm."memberId"
          FROM "ContextMembers" cm JOIN scope s ON s."id" = cm."contextId"
          JOIN "IdentityMembers" im ON im."identityId" = cm."memberId"
         WHERE cm."memberType" = 'Identity'
      ) m
      JOIN "Principals" p ON p."id" = m."principalId" AND p."deletedAt" IS NULL
  )`;

const LIVE_ASSIGNMENT = `ra."deletedAt" IS NULL AND r."deletedAt" IS NULL AND r."resourceType" NOT IN ${OWNERSHIP_TYPES_SQL}`;

// A "person" is the Identity when the account is linked to one, otherwise the account.
// Identity members are people in their own right: one without (live) accounts is still
// on the team, with zero access — found by the contract test, where team_principals alone
// returned nobody.
export const MEMBERS_SQL = `${SCOPE_CTE}, ${TEAM_PRINCIPALS},
  people AS (
    SELECT cm."memberId" AS "personId"
      FROM "ContextMembers" cm JOIN scope s ON s."id" = cm."contextId"
     WHERE cm."memberType" = 'Identity'
    UNION
    SELECT "personId" FROM team_principals
  )
  SELECT pe."personId" AS "id",
         CASE WHEN i."id" IS NOT NULL THEN 'identity' ELSE 'account' END AS "kind",
         COALESCE(i."displayName", p."displayName") AS "displayName",
         COALESCE(i."jobTitle", p."jobTitle") AS "jobTitle",
         COALESCE(i."department", p."department") AS "department",
         COALESCE(a."direct", 0) AS "direct", COALESCE(a."indirect", 0) AS "indirect", COALESCE(a."eligible", 0) AS "eligible",
         count(*) OVER () AS "total"
    FROM people pe
    LEFT JOIN "Identities" i ON i."id" = pe."personId"
    LEFT JOIN "Principals" p ON p."id" = pe."personId"
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE ra."assignmentType" = 'Direct') AS "direct",
             count(*) FILTER (WHERE ra."assignmentType" = 'Indirect') AS "indirect",
             count(*) FILTER (WHERE ra."assignmentType" = 'Eligible') AS "eligible"
        FROM team_principals tp
        JOIN "ResourceAssignments" ra ON ra."principalId" = tp."id"
        JOIN "Resources" r ON r."id" = ra."resourceId"
       WHERE tp."personId" = pe."personId" AND ${LIVE_ASSIGNMENT}
    ) a ON TRUE
   ORDER BY 3, 1
   LIMIT ${MAX_MEMBERS}`;

export const RESOURCES_SQL = `${SCOPE_CTE}, ${TEAM_PRINCIPALS}
  SELECT r."id", r."displayName", r."resourceType",
         count(DISTINCT tp."personId") AS "holders",
         count(*) OVER () AS "total"
    FROM team_principals tp
    JOIN "ResourceAssignments" ra ON ra."principalId" = tp."id" AND ra."assignmentType" IN ('Direct','Indirect')
    JOIN "Resources" r ON r."id" = ra."resourceId"
   WHERE ${LIVE_ASSIGNMENT}
   GROUP BY r."id", r."displayName", r."resourceType"
   ORDER BY "holders" DESC, r."displayName", r."id"
   LIMIT ${MAX_RESOURCES}`;

const SUBJECT_SQL = `SELECT i."id", i."displayName", i."jobTitle", i."department",
       (SELECT count(*) FROM "IdentityMembers" im JOIN "Principals" p ON p."id" = im."principalId"
         WHERE im."identityId" = i."id" AND p."deletedAt" IS NULL) AS "accountCount"
  FROM "Identities" i WHERE i."id" = $1`;

const SCOPE_SQL = `SELECT c."id", c."displayName", c."contextType", c."targetType" FROM "Contexts" c WHERE c."id" = $1`;

// Contexts whose members are people. A Resource or System context is not a team.
const PEOPLE_TARGETS = new Set(['Identity', 'Principal']);

const num = (v) => Number(v ?? 0);

/** Splits `total` off the rows and reports whether the cap cut anything. */
export function capped(rows, cap) {
  const total = rows.length ? num(rows[0].total) : 0;
  return { items: rows.map(({ total: _t, ...rest }) => rest), total, truncated: total > cap };
}

/**
 * @returns {Promise<{ status: number, error?: string, body?: object }>}
 */
export async function readInterviewContext(query, { subjectIdentityId, scopeContextId }) {
  const body = { subject: null, scope: null };
  if (subjectIdentityId) {
    const s = (await query(SUBJECT_SQL, [subjectIdentityId])).rows[0];
    if (!s) return { status: 404, error: 'Subject not found' };
    body.subject = { ...s, accountCount: num(s.accountCount) };
  }
  if (scopeContextId) {
    const c = (await query(SCOPE_SQL, [scopeContextId])).rows[0];
    if (!c) return { status: 404, error: 'Scope context not found' };
    if (!PEOPLE_TARGETS.has(c.targetType)) return { status: 400, error: 'The scope must be a context of people (identities or accounts)' };
    const members = capped((await query(MEMBERS_SQL, [scopeContextId])).rows, MAX_MEMBERS);
    const resources = capped((await query(RESOURCES_SQL, [scopeContextId])).rows, MAX_RESOURCES);
    body.scope = {
      ...c,
      members: { ...members, items: members.items.map(m => ({ ...m, direct: num(m.direct), indirect: num(m.indirect), eligible: num(m.eligible) })) },
      resources: { ...resources, items: resources.items.map(r => ({ ...r, holders: num(r.holders) })) },
    };
  }
  return { status: 200, body };
}
