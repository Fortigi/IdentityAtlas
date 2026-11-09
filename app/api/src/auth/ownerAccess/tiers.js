// How far a context owner may look at one object — the data half of the
// owner-access scope (docs/architecture/context-owner-access.md → "Exploring the
// team").
//
// Given the owner's in-scope context ids (auth/contextOwner.js), every object is
// in one of four tiers:
//
//   'team'  a member of an in-scope context. For people that crosses the
//           account/person link both ways: an account is on the team when it,
//           or the person it belongs to, is a member; a person when they, or one
//           of their accounts, is. A resource is on the team when it is itself a
//           member (a unit of resources, an application).
//   'held'  a resource a team member holds — a live Direct, Indirect or Eligible
//           assignment made to a team account or a team person.
//   'holder' the mirror for a context of resources (an application): an account
//           or a person holding — live Direct, Indirect or Eligible — a resource
//           that is a member of an in-scope context. The same crossover as the
//           team: an account is a holder when it, or its person, holds one; a
//           person when they, or one of their accounts, do. What a holder holds
//           OUTSIDE the application is not 'held' (held is the team's only),
//           so it stays name-only: one step out, no further.
//   null    everything else: the owner sees its name where it is referenced,
//           never its own page.
//
// 'team', 'held' and 'holder' objects open in full; the null tier is
// name-only. An owner of several contexts gets the union over all of them (the
// statements take every in-scope context id at once).
//
// Every statement takes the ids as a batch (one round trip per kind, whatever
// the batch size) and is written for scale: the team side is reached through
// the ContextMembers primary key (contextId, memberId) and the
// IdentityMembers indexes, "held" is an EXISTS per candidate resource through
// ix_RA_resourceId, and "holder" an EXISTS per candidate account or person
// through ix_RA_principalId / the identityId index (migration 036), each
// assignment checked against the ContextMembers primary key — never a load of
// the team's or the application's assignments.
//
// Every function takes the pool explicitly so the contract test can run the
// exact statements against PostgreSQL (contract-tests/ownerAccess.contract.test.js).

export const TEAM = 'team';
export const HELD = 'held';
export const HOLDER = 'holder';

// The kinds the classifier knows. 'member' is "a direct member of an in-scope
// context, whatever its type" — what a context's own member list holds.
export const KINDS = Object.freeze(['principal', 'identity', 'resource', 'member']);

// Every predicate below is a function of two SQL expressions, so the one
// definition serves two callers:
//   `id`     the object being judged — `x.id` for a batch of candidates
//            (TIER_SQL below), a table column such as `t3."id"` when the scope
//            is applied inside a query (nlreports/scope.js, the MCP server);
//   `scope`  the owner's context ids as a uuid[] — `$1::uuid[]` here.
// REST and MCP therefore cannot disagree about who opens what: they run the
// same SQL text (contract-tests/authzSecurity.integration.test.js checks it).
const inScope = (scope) => `cm."contextId" = ANY(${scope})`;

// The team's accounts and the team's people, as sub-selects over the scope.
const teamPrincipals = (scope) => `
  SELECT cm."memberId" FROM "ContextMembers" cm WHERE ${inScope(scope)} AND cm."memberType" = 'Principal'
  UNION ALL
  SELECT im."principalId" FROM "ContextMembers" cm
    JOIN "IdentityMembers" im ON im."identityId" = cm."memberId"
   WHERE ${inScope(scope)} AND cm."memberType" = 'Identity'`;
const teamIdentities = (scope) => `
  SELECT cm."memberId" FROM "ContextMembers" cm WHERE ${inScope(scope)} AND cm."memberType" = 'Identity'
  UNION ALL
  SELECT im."identityId" FROM "ContextMembers" cm
    JOIN "IdentityMembers" im ON im."principalId" = cm."memberId"
   WHERE ${inScope(scope)} AND cm."memberType" = 'Principal'`;

// A live assignment, matched by `holderMatch` (a predicate on a."principalId"
// or a."identityId"), on a resource that is a member of an in-scope context.
const LIVE = `a."deletedAt" IS NULL AND a."assignmentType" IN ('Direct', 'Indirect', 'Eligible')`;
const holdsScopedResource = (scope, from, holderMatch) => `EXISTS (SELECT 1 FROM ${from}
     JOIN "ContextMembers" cm ON cm."memberId" = a."resourceId" AND cm."memberType" = 'Resource' AND ${inScope(scope)}
    WHERE ${holderMatch} AND ${LIVE})`;

const isMember = (id, scope, memberType) => `EXISTS (SELECT 1 FROM "ContextMembers" cm
   WHERE ${inScope(scope)} AND cm."memberId" = ${id}${memberType ? ` AND cm."memberType" = '${memberType}'` : ''})`;

// 'team' for each kind: a member of an in-scope context, people crossing the
// account/person link both ways.
const TEAM_OF = {
  principal: (id, scope) => `(${isMember(id, scope, 'Principal')}
        OR EXISTS (SELECT 1 FROM "IdentityMembers" im
                     JOIN "ContextMembers" cm ON cm."memberId" = im."identityId" AND cm."memberType" = 'Identity'
                    WHERE im."principalId" = ${id} AND ${inScope(scope)}))`,
  identity: (id, scope) => `(${isMember(id, scope, 'Identity')}
        OR EXISTS (SELECT 1 FROM "IdentityMembers" im
                     JOIN "ContextMembers" cm ON cm."memberId" = im."principalId" AND cm."memberType" = 'Principal'
                    WHERE im."identityId" = ${id} AND ${inScope(scope)}))`,
  resource: (id, scope) => isMember(id, scope, 'Resource'),
  member: (id, scope) => isMember(id, scope, null),
};

// The second tier: 'holder' for an account (itself or through its person) or a
// person (itself or through one of their accounts); 'held' for a resource.
const REACH_OF = {
  principal: (id, scope) => `(${holdsScopedResource(scope, '"ResourceAssignments" a', `a."principalId" = ${id}`)}
        OR ${holdsScopedResource(scope, '"IdentityMembers" im JOIN "ResourceAssignments" a ON a."identityId" = im."identityId"', `im."principalId" = ${id}`)})`,
  identity: (id, scope) => `(${holdsScopedResource(scope, '"ResourceAssignments" a', `a."identityId" = ${id}`)}
        OR ${holdsScopedResource(scope, '"IdentityMembers" im JOIN "ResourceAssignments" a ON a."principalId" = im."principalId"', `im."identityId" = ${id}`)})`,
  resource: (id, scope) => `EXISTS (SELECT 1 FROM "ResourceAssignments" a
                    WHERE a."resourceId" = ${id} AND ${LIVE}
                      AND (a."principalId" IN (${teamPrincipals(scope)})
                        OR a."identityId" IN (${teamIdentities(scope)})))`,
};

/**
 * "May this owner open the object `id`?" as one SQL predicate per kind — the
 * union of the tiers that open in full. A context opens when it is one of the
 * scope's ids. `id` and `scope` are SQL expressions (see above), never values.
 */
export const OPENABLE_SQL = Object.freeze({
  principal: (id, scope) => `(${TEAM_OF.principal(id, scope)} OR ${REACH_OF.principal(id, scope)})`,
  identity: (id, scope) => `(${TEAM_OF.identity(id, scope)} OR ${REACH_OF.identity(id, scope)})`,
  resource: (id, scope) => `(${TEAM_OF.resource(id, scope)} OR ${REACH_OF.resource(id, scope)})`,
  context: (id, scope) => `${id} = ANY(${scope})`,
});

// $1 = the owner's context ids, $2 = the candidate ids.
const BATCH_SCOPE = '$1::uuid[]';
const X = 'x.id';

// An account or a person: 'team' when the team predicate holds, else 'holder'.
const tiered = (kind) => `
    SELECT x.id, CASE WHEN ${TEAM_OF[kind](X, BATCH_SCOPE)} THEN '${TEAM}' ELSE '${HOLDER}' END AS tier
      FROM unnest($2::uuid[]) AS x(id)
     WHERE ${OPENABLE_SQL[kind](X, BATCH_SCOPE)}`;

export const TIER_SQL = {
  principal: tiered('principal'),
  identity: tiered('identity'),
  resource: `
    SELECT x.id, CASE WHEN ${TEAM_OF.resource(X, BATCH_SCOPE)} THEN '${TEAM}' ELSE '${HELD}' END AS tier
      FROM unnest($2::uuid[]) AS x(id)
     WHERE ${OPENABLE_SQL.resource(X, BATCH_SCOPE)}`,
  member: `
    SELECT x.id, '${TEAM}' AS tier FROM unnest($2::uuid[]) AS x(id) WHERE ${TEAM_OF.member(X, BATCH_SCOPE)}`,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The distinct, well-formed (uuid), lower-cased ids of a batch. Anything else
// can never be openable, so it never reaches the database.
export function cleanIds(ids) {
  const out = new Set();
  for (const id of ids || []) {
    const v = String(id ?? '').toLowerCase();
    if (UUID_RE.test(v)) out.add(v);
  }
  return [...out];
}

// Map<id, 'team' | 'held'> for the ids of `kind` that open in full; an id not
// in the map is name-only. Context ids are not classified here — a context is
// openable when it is one of `contextIds` (no database needed).
export async function classifyTiers(pool, contextIds, kind, ids) {
  const sql = TIER_SQL[kind];
  if (!sql) throw new Error(`unknown owner-access kind: ${kind}`);
  const wanted = cleanIds(ids);
  const scope = [...contextIds];
  if (wanted.length === 0 || scope.length === 0) return new Map();
  const { rows } = await pool.query(sql, [scope, wanted]);
  return new Map(rows.map(r => [String(r.id).toLowerCase(), r.tier]));
}
