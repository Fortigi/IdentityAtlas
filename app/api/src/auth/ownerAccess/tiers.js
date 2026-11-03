// How far a context owner may look at one object — the data half of the
// owner-access scope (docs/architecture/context-owner-access.md → "Exploring the
// team").
//
// Given the owner's in-scope context ids (auth/contextOwner.js), every object is
// in one of three tiers:
//
//   'team'  a member of an in-scope context. For people that crosses the
//           account/person link both ways: an account is on the team when it,
//           or the person it belongs to, is a member; a person when they, or one
//           of their accounts, is. A resource is on the team when it is itself a
//           member (a unit of resources, an application).
//   'held'  a resource a team member holds — a live Direct, Indirect or Eligible
//           assignment made to a team account or a team person.
//   null    everything else: the owner sees its name where it is referenced,
//           never its own page.
//
// 'team' and 'held' objects open in full; the null tier is name-only.
//
// Every statement takes the ids as a batch (one round trip per kind, whatever
// the batch size) and is written for scale: the team side is reached through
// the ContextMembers primary key (contextId, memberId) and the
// IdentityMembers indexes, and "held" is an EXISTS per candidate resource
// through ix_RA_resourceId — never a load of the team's assignments.
//
// Every function takes the pool explicitly so the contract test can run the
// exact statements against PostgreSQL (contract-tests/ownerAccess.contract.test.js).

export const TEAM = 'team';
export const HELD = 'held';

// The kinds the classifier knows. 'member' is "a direct member of an in-scope
// context, whatever its type" — what a context's own member list holds.
export const KINDS = Object.freeze(['principal', 'identity', 'resource', 'member']);

// $1 = the owner's context ids, $2 = the candidate ids.
const IN_SCOPE = `cm."contextId" = ANY($1::uuid[])`;

// The team's accounts and the team's people, as sub-selects over $1.
const TEAM_PRINCIPALS = `
  SELECT cm."memberId" FROM "ContextMembers" cm WHERE ${IN_SCOPE} AND cm."memberType" = 'Principal'
  UNION ALL
  SELECT im."principalId" FROM "ContextMembers" cm
    JOIN "IdentityMembers" im ON im."identityId" = cm."memberId"
   WHERE ${IN_SCOPE} AND cm."memberType" = 'Identity'`;
const TEAM_IDENTITIES = `
  SELECT cm."memberId" FROM "ContextMembers" cm WHERE ${IN_SCOPE} AND cm."memberType" = 'Identity'
  UNION ALL
  SELECT im."identityId" FROM "ContextMembers" cm
    JOIN "IdentityMembers" im ON im."principalId" = cm."memberId"
   WHERE ${IN_SCOPE} AND cm."memberType" = 'Principal'`;

const isMember = (memberType) => `EXISTS (SELECT 1 FROM "ContextMembers" cm
   WHERE ${IN_SCOPE} AND cm."memberId" = x.id${memberType ? ` AND cm."memberType" = '${memberType}'` : ''})`;

export const TIER_SQL = {
  principal: `
    SELECT x.id, '${TEAM}' AS tier FROM unnest($2::uuid[]) AS x(id)
     WHERE ${isMember('Principal')}
        OR EXISTS (SELECT 1 FROM "IdentityMembers" im
                     JOIN "ContextMembers" cm ON cm."memberId" = im."identityId" AND cm."memberType" = 'Identity'
                    WHERE im."principalId" = x.id AND ${IN_SCOPE})`,
  identity: `
    SELECT x.id, '${TEAM}' AS tier FROM unnest($2::uuid[]) AS x(id)
     WHERE ${isMember('Identity')}
        OR EXISTS (SELECT 1 FROM "IdentityMembers" im
                     JOIN "ContextMembers" cm ON cm."memberId" = im."principalId" AND cm."memberType" = 'Principal'
                    WHERE im."identityId" = x.id AND ${IN_SCOPE})`,
  resource: `
    SELECT x.id, CASE WHEN ${isMember('Resource')} THEN '${TEAM}' ELSE '${HELD}' END AS tier
      FROM unnest($2::uuid[]) AS x(id)
     WHERE ${isMember('Resource')}
        OR EXISTS (SELECT 1 FROM "ResourceAssignments" a
                    WHERE a."resourceId" = x.id AND a."deletedAt" IS NULL
                      AND a."assignmentType" IN ('Direct', 'Indirect', 'Eligible')
                      AND (a."principalId" IN (${TEAM_PRINCIPALS})
                        OR a."identityId" IN (${TEAM_IDENTITIES})))`,
  member: `
    SELECT x.id, '${TEAM}' AS tier FROM unnest($2::uuid[]) AS x(id) WHERE ${isMember(null)}`,
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
