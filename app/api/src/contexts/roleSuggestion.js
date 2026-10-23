// Best guess for who is Accountable for a context that has none yet.
// Design: docs/architecture/template-ui.md §2.
//
// One signal per kind of member, first that gives a candidate wins:
//   - people (Identity) or accounts (Principal): the manager of the most
//     members — Identities.managerIdentityId / Principals.managerId;
//   - resources: the account that owns the most of them — the holders of the
//     ownership resources (OWNERSHIP_RESOURCE_TYPES) linked from a member by an
//     ownership relationship (OWNERSHIP_RELATIONSHIP_TYPES), the same walk the
//     Entitlement Pivot report makes for its owner column.
// A candidate is suggested only when they cover at least SUGGESTION_THRESHOLD
// of the members, and never when an analyst rejected them for this context
// (ContextRoleSuggestionRejections, migration 093).

import * as db from '../db/connection.js';
import { OWNERSHIP_TYPES_SQL, OWNERSHIP_RELATIONSHIP_TYPES_SQL } from '../lib/ownershipTypes.js';

export const SUGGESTION_THRESHOLD = 0.4;

// The best of `candidates` ([{ id, displayName, count }]) when it covers at
// least the threshold of `total` members, else null. On a tie the earlier one
// wins, so the caller's order (the SQL's) decides.
export function pickCandidate(candidates, total) {
  if (!(total > 0)) return null;
  let best = null;
  for (const c of candidates) {
    if (!best || c.count > best.count) best = c;
  }
  return best && best.count / total >= SUGGESTION_THRESHOLD ? best : null;
}

// The candidate is not someone an analyst rejected as this context's Accountable.
const notRejected = (holderCol, candidateExpr) => `
       AND NOT EXISTS (
             SELECT 1 FROM "ContextRoleSuggestionRejections" x
              WHERE x."contextId" = $1 AND x.role = 'Accountable' AND x."${holderCol}" = ${candidateExpr})`;

// Managers of the members, most members first. `live` filters soft-deleted
// rows on tables that have them (Principals; Identities has no deletedAt).
const managerSql = ({ table, managerCol, memberType, holderCol, live }) => `
    SELECT m.id, m."displayName", COUNT(*)::int AS count
      FROM "ContextMembers" cm
      JOIN "${table}" e ON e.id = cm."memberId"${live('e')}
      JOIN "${table}" m ON m.id = e."${managerCol}"${live('m')}
     WHERE cm."contextId" = $1 AND cm."memberType" = '${memberType}'${notRejected(holderCol, 'm.id')}
     GROUP BY m.id, m."displayName"
     ORDER BY count DESC, m."displayName", m.id
     LIMIT 1`;

const liveDeletedAt = (alias) => ` AND ${alias}."deletedAt" IS NULL`;
const always = () => '';

// Owners of the member resources, most resources first.
const OWNER_SQL = `
    SELECT p.id, p."displayName", COUNT(DISTINCT cm."memberId")::int AS count
      FROM "ContextMembers" cm
      JOIN "ResourceRelationships" rr ON rr."parentResourceId" = cm."memberId"
       AND rr."relationshipType" IN ${OWNERSHIP_RELATIONSHIP_TYPES_SQL}
      JOIN "Resources" o ON o.id = rr."childResourceId"
       AND o."resourceType" IN ${OWNERSHIP_TYPES_SQL}
       AND o."deletedAt" IS NULL
      JOIN "ResourceAssignments" ra ON ra."resourceId" = o.id
       AND ra."assignmentType" = 'Direct' AND ra."deletedAt" IS NULL
      JOIN "Principals" p ON p.id = ra."principalId" AND p."deletedAt" IS NULL
     WHERE cm."contextId" = $1 AND cm."memberType" = 'Resource'${notRejected('principalId', 'p.id')}
     GROUP BY p.id, p."displayName"
     ORDER BY count DESC, p."displayName", p.id
     LIMIT 1`;

// "3 of the 4 members", but "the only member" / "all 5 members" rather than
// "1 of the 1" / "5 of the 5".
export function share(count, total, noun) {
  if (total === 1) return `the only ${noun}`;
  if (count === total) return `all ${total} ${noun}s`;
  return `${count} of the ${total} ${noun}s`;
}

// targetType → how to find the candidate and how to say why.
export const SIGNALS = {
  Identity: {
    holderCol: 'identityId',
    sql: managerSql({ table: 'Identities', managerCol: 'managerIdentityId', memberType: 'Identity', holderCol: 'identityId', live: always }),
    reason: (count, total) => `manages ${share(count, total, 'member')}`,
  },
  Principal: {
    holderCol: 'principalId',
    sql: managerSql({ table: 'Principals', managerCol: 'managerId', memberType: 'Principal', holderCol: 'principalId', live: liveDeletedAt }),
    reason: (count, total) => `manages ${share(count, total, 'member')}`,
  },
  Resource: {
    holderCol: 'principalId',
    sql: OWNER_SQL,
    reason: (count, total) => `owns ${share(count, total, 'resource')}`,
  },
};

// The suggested Accountable for `context` ({ id, targetType }), or null when
// its kind of member has no signal, it has no members of that kind, or no
// candidate reaches the threshold.
export async function suggestAccountable(context) {
  const signal = SIGNALS[context.targetType];
  if (!signal) return null;
  const totalRow = await db.queryOne(
    `SELECT COUNT(*)::int AS total FROM "ContextMembers" WHERE "contextId" = $1 AND "memberType" = $2`,
    [context.id, context.targetType],
  );
  const total = totalRow?.total || 0;
  if (!total) return null;
  const { rows } = await db.query(signal.sql, [context.id]);
  const best = pickCandidate(rows, total);
  if (!best) return null;
  return {
    role: 'Accountable',
    [signal.holderCol]: best.id,
    displayName: best.displayName,
    reason: signal.reason(best.count, total),
    count: best.count,
    total,
  };
}
