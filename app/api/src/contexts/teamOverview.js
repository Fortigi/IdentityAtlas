// A unit's team at a glance — GET /api/contexts/:id/team-overview.
//
// What the person who answers for a unit needs to see, without the permissions
// themselves: which business roles each DIRECT member holds, how many of their
// permissions no role of theirs accounts for, and who joined, left or changed
// role recently.
//
//   ungoverned   a live resource the person holds that is not a business role
//                and that no business role OF THEIRS covers. Covered is what
//                "vw_UserPermissionAssignmentViaBusinessRole" says (the matrix's
//                governed share, routes/matrix/scope.js), plus what they hold
//                ONLY by inheritance and that a group in one of their roles
//                passes on, however deep. A direct grant on the same resource
//                was made around the role, so it stays ungoverned. The matrix
//                does not apply that second half yet.
//   changes      joins and leaves come from the unit's membership history
//                (contexts/timeline/unitTimeline.js); role changes from the
//                assignment history of the current members.

import { loadUnitMembershipEvents } from './timeline/unitTimeline.js';
import { changeAction } from '../routes/recentChanges/shared.js';
import { ROLE_CONTROL_SQL, roleAccessModels } from '../lib/businessRoleAccessModel.js';
import { ROLE_REVIEW_SQL, roleReviews } from '../lib/businessRoleReview.js';
import { isMissingSchema } from '../db/schemaErrors.js';

export const MAX_TEAM = 200;
export const MAX_CHANGES = 100;
export const ROLE_HISTORY_CAP = 2000;

// $1 the member ids. A member that is an account is its own account (with its
// person, if linked); a member that is a person brings each of their accounts.
export const TEAM_ACCOUNTS_SQL = `
    SELECT p.id AS "memberId", p.id AS "accountId", im."identityId"
      FROM "Principals" p
      LEFT JOIN "IdentityMembers" im ON im."principalId" = p.id
     WHERE p.id = ANY($1::uuid[])
    UNION
    SELECT im."identityId", im."principalId", im."identityId"
      FROM "IdentityMembers" im
     WHERE im."identityId" = ANY($1::uuid[])`;

export const LIVE_ASSIGNMENT = `ra."deletedAt" IS NULL AND ra."assignmentType" IN ('Direct', 'Indirect', 'Eligible')`;

// $1 member ids, $2 their account ids, $3 those accounts' person ids (parallel arrays).
export const TEAM_ACCOUNTS_CTE = `acct AS (
      SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[]) AS t("memberId", "accountId", "identityId")
    )`;

// After `WITH RECURSIVE`: the accounts; `governed`, what each member's roles
// cover and what those groups pass on (UNION stops on a nesting cycle); and
// `held`, one row per (member, resource). A role held through several assignments
// shows its strongest origin: a rule keeps it whatever else happens.
export const TEAM_SCOPE_CTES = `${TEAM_ACCOUNTS_CTE}, governed("memberId", "resourceId") AS (
      SELECT mine."memberId", cov."resourceId"
        FROM acct mine JOIN "vw_UserPermissionAssignmentViaBusinessRole" cov ON cov."userId" = mine."accountId"
      UNION
      SELECT g."memberId", ra."resourceId"
        FROM governed g JOIN "ResourceAssignments" ra ON ra."principalId" = g."resourceId"
       WHERE ${LIVE_ASSIGNMENT}
    ), held AS (
      SELECT DISTINCT ON (u."memberId", u."resourceId")
             u."memberId", u."resourceId", u.origin, u."originDetail",
             bool_or(u."assignmentType" = 'Direct') OVER same AS direct,
             bool_or(u."assignmentType" = 'Indirect') OVER same AS indirect
        FROM (
          SELECT a."memberId", ra."resourceId", ra."assignmentType", ra.origin, ra."originDetail"
            FROM acct a JOIN "ResourceAssignments" ra ON ra."principalId" = a."accountId"
           WHERE ${LIVE_ASSIGNMENT}
          UNION ALL
          SELECT a."memberId", ra."resourceId", ra."assignmentType", ra.origin, ra."originDetail"
            FROM acct a JOIN "ResourceAssignments" ra ON ra."identityId" = a."identityId"
           WHERE ${LIVE_ASSIGNMENT}
        ) u
      WINDOW same AS (PARTITION BY u."memberId", u."resourceId")
       ORDER BY u."memberId", u."resourceId",
                CASE u.origin WHEN 'Automatic' THEN 0 WHEN 'Requested' THEN 1 ELSE 2 END
    )`;

// The one definition of ungoverned, for a row `h` of `held`.
export const IS_UNGOVERNED = `NOT EXISTS (
             SELECT 1 FROM "vw_UserPermissionAssignmentViaBusinessRole" cov
               JOIN acct mine ON mine."accountId" = cov."userId"
              WHERE mine."memberId" = h."memberId" AND cov."resourceId" = h."resourceId")
           AND (h.direct OR NOT EXISTS (
             SELECT 1 FROM governed g WHERE g."memberId" = h."memberId" AND g."resourceId" = h."resourceId"))`;

// One row per member that holds anything.
export const TEAM_HOLDINGS_SQL = `
    WITH RECURSIVE ${TEAM_SCOPE_CTES}
    SELECT h."memberId",
           COUNT(*) FILTER (WHERE NOT r."governanceResource")::int AS permissions,
           COUNT(*) FILTER (WHERE NOT r."governanceResource" AND ${IS_UNGOVERNED})::int AS ungoverned,
           COALESCE(jsonb_agg(jsonb_build_object('id', r.id, 'displayName', r."displayName", 'origin', h.origin, 'originDetail', h."originDetail"))
                    FILTER (WHERE r."governanceResource"), '[]'::jsonb) AS roles
      FROM held h
      JOIN "Resources" r ON r.id = h."resourceId" AND r."deletedAt" IS NULL
     GROUP BY h."memberId"`;

// $1 days, $2 holder ids (text[]), $3 cap. `column` is one of this file's two
// literals. A soft delete is an UPDATE, so updates are read too (changeAction).
export const roleHistorySql = (column) => `
    SELECT h.operation, h."changedAt", h."rowData", h."prevData", r."displayName" AS "roleName"
      FROM "_history" h
      JOIN "Resources" r ON r.id::text = h."rowData"->>'resourceId' AND r."governanceResource"
     WHERE h."tableName" = 'ResourceAssignments'
       AND h."rowData"->>'${column}' = ANY($2::text[])
       AND h."changedAt" > now() - ($1::int || ' days')::interval
     ORDER BY h."changedAt" DESC
     LIMIT $3`;

const byName = (a, b) => a.displayName.localeCompare(b.displayName);

/**
 * The people (in member order) and the roles (most held first, then by name),
 * each role with its type and its last review, as the Business Roles list shows
 * them: properties of the role, not of a holder. Pure.
 */
const UNKNOWN_MODEL = Object.freeze({ waysIn: ['Unknown'], waysOut: ['Unknown'], control: 'Unknown', reviewRequired: false, reviewGap: false });
const NO_REVIEW = Object.freeze({ complianceStatus: null, reviewDeadline: null, daysOverdue: 0 });

export function teamGrid(members, holdings, models = new Map(), reviews = new Map()) {
  const held = new Map(holdings.map(h => [h.memberId, h]));
  const roles = new Map();
  const people = members.map((m) => {
    const h = held.get(m.id);
    for (const role of h?.roles || []) {
      if (!roles.has(role.id)) {
        const accessModel = models.get(role.id) ?? UNKNOWN_MODEL;
        roles.set(role.id, {
          id: role.id, displayName: role.displayName, accessModel,
          review: { ...(reviews.get(role.id) ?? NO_REVIEW), hasReviewConfigured: accessModel.waysOut.includes('Review') },
          holders: [], origins: {},
        });
      }
      const entry = roles.get(role.id);
      entry.holders.push(m.id);
      entry.origins[m.id] = { origin: role.origin ?? null, originDetail: role.originDetail ?? null };
    }
    return {
      id: m.id,
      displayName: m.displayName,
      kind: m.memberType === 'Identity' ? 'identity' : 'user',
      permissions: h?.permissions ?? 0,
      ungoverned: h?.ungoverned ?? 0,
    };
  });
  return {
    people,
    roles: [...roles.values()].sort((a, b) => b.holders.length - a.holders.length || byName(a, b)),
  };
}

// No review data at all (no CertificationDecisions table) is no review, not an error.
async function loadRoleReviews(db, roleIds) {
  try {
    return roleReviews((await db.query(ROLE_REVIEW_SQL, [roleIds])).rows);
  } catch (err) {
    if (!isMissingSchema(err)) throw err;
    return new Map();
  }
}

/**
 * The grid for these members ({ id, displayName, memberType }): shared by the
 * screen and the unit report's Team roles tab.
 */
export async function loadTeamGrid(db, members) {
  const ids = members.map(m => m.id);
  const accounts = ids.length ? (await db.query(TEAM_ACCOUNTS_SQL, [ids])).rows : [];
  const holdings = accounts.length
    ? (await db.query(TEAM_HOLDINGS_SQL, [accounts.map(a => a.memberId), accounts.map(a => a.accountId), accounts.map(a => a.identityId)])).rows
    : [];
  const roleIds = [...new Set(holdings.flatMap(h => (h.roles || []).map(r => r.id)))];
  const models = roleIds.length ? roleAccessModels((await db.query(ROLE_CONTROL_SQL, [roleIds])).rows) : new Map();
  const reviews = roleIds.length ? await loadRoleReviews(db, roleIds) : new Map();
  return { ...teamGrid(members, holdings, models, reviews), accounts };
}

/** Who joined and left, from the unit's timeline events. Pure. */
export function membershipChanges(events) {
  return events
    .filter(e => e.burst?.key?.startsWith('people:joined') || e.burst?.key?.startsWith('people:left'))
    .map(e => ({
      at: e.at,
      type: e.operation === 'added' ? 'joined' : 'left',
      personKind: e.counterpartyKind,
      personId: e.counterpartyId,
      personName: e.counterpartyLabel,
    }));
}

/**
 * Role changes from assignment-history rows. `holderOf(row)` names the team
 * member the row belongs to. One person's two accounts changing the same role
 * at the same moment is one change. Pure.
 */
export function roleChanges(rows, holderOf) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const action = changeAction(row);
    const person = holderOf(row);
    if (!action || !person) continue;
    const type = action === 'added' ? 'role-added' : 'role-removed';
    const key = `${person.id}|${row.rowData?.resourceId}|${type}|${new Date(row.changedAt).getTime()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ at: row.changedAt, type, personKind: person.kind, personId: person.id, personName: person.displayName, roleName: row.roleName });
  }
  return out;
}

/** Newest first, capped. Pure. */
export function latestChanges(changes, cap = MAX_CHANGES) {
  return [...changes].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, cap);
}

// Which team member an assignment-history row belongs to.
function holderLookup(people, accounts) {
  const personOf = new Map(people.map(p => [p.id, p]));
  const byAccount = new Map();
  const byIdentity = new Map();
  for (const a of accounts) {
    byAccount.set(a.accountId, personOf.get(a.memberId));
    if (a.identityId) byIdentity.set(a.identityId, personOf.get(a.memberId));
  }
  return (row) => byAccount.get(row.rowData?.principalId) || byIdentity.get(row.rowData?.identityId) || null;
}

const distinctIds = (values) => [...new Set(values.filter(Boolean))];

async function loadRoleHistory(db, accounts, sinceDays) {
  const accountIds = distinctIds(accounts.map(a => a.accountId));
  const identityIds = distinctIds(accounts.map(a => a.identityId));
  const read = (column, ids) => (ids.length
    ? db.query(roleHistorySql(column), [sinceDays, ids, ROLE_HISTORY_CAP])
    : Promise.resolve({ rows: [] }));
  const [byAccount, byIdentity] = await Promise.all([read('principalId', accountIds), read('identityId', identityIds)]);
  return {
    rows: [...byAccount.rows, ...byIdentity.rows],
    capped: byAccount.rows.length >= ROLE_HISTORY_CAP || byIdentity.rows.length >= ROLE_HISTORY_CAP,
  };
}

/**
 * The overview of a unit of people. `ctx` { id, targetType }; `includeOverridden`
 * lists members a decision marked former too (organisation knowledge off).
 */
export async function loadTeamOverview({ db, loadMembers }, ctx, { sinceDays, includeOverridden = false }) {
  const { rows: members, total } = await loadMembers(ctx.id, ctx.targetType, { limit: MAX_TEAM, withTotal: true, includeOverridden });
  const typed = members.map(m => ({ ...m, memberType: ctx.targetType }));
  const { people, roles, accounts } = await loadTeamGrid(db, typed);
  const [membership, history] = await Promise.all([
    loadUnitMembershipEvents(db, ctx.id, { sinceDays }),
    loadRoleHistory(db, accounts, sinceDays),
  ]);
  const all = [...membershipChanges(membership.events), ...roleChanges(history.rows, holderLookup(people, accounts))];
  return {
    sinceDays,
    people,
    roles,
    changes: latestChanges(all),
    totalPeople: total,
    truncated: total > people.length || all.length > MAX_CHANGES || history.capped || membership.truncated,
  };
}
