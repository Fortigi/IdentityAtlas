// A unit's timeline — the SQL (the words are unitEvents.js).
//
//   loadUnitTimeline(db, contextId, { sinceDays, interviewEvents }) → { events, truncated }
//
// Read from what already records history, never from a store of its own:
//   - _history rows of the unit: its Contexts row, its memberships (migration
//     109, keyed by the context), and the ContextRoles / ChangeRequests /
//     ContextTreeAdjustments rows that name it. The last three are small tables
//     reached by the ("tableName","rowId","changedAt") index on tableName alone.
//   - the Principals history of its people (current members, their accounts,
//     and whoever left in the window): job title, department, manager,
//     disabled, deleted in the source.
//   - memberships older than the membership history: their addedAt (members a
//     rule adds are left out — before migration 109 the runner re-stamped them
//     on every refresh).
//   - the interview events, from the caller (they are organisation knowledge
//     and the caller knows the flag and the reader).

import {
  membershipEvent, membershipEvents, roleEvents, contextRowEvents, changeRequestEvents, adjustmentEvents,
  personAttributeEvents, sortEvents,
} from './unitEvents.js';

// Context columns that change without anything happening to the context.
export const CONTEXT_NOISE_FIELDS = Object.freeze(['lastCalculatedAt', 'updatedAt', 'directMemberCount', 'totalMemberCount', 'ValidFrom', 'ValidTo']);
const NOISE = `ARRAY[${CONTEXT_NOISE_FIELDS.map(f => `'${f}'`).join(', ')}]::text[]`;

// Rows read per statement; a burst larger than this (a first upload of a big
// list) is cut, and the answer says so.
export const UNIT_TIMELINE_ROW_CAP = 2000;
const MAX_PEOPLE_IDS = 5000;

const WINDOW = `now() - ($1::int || ' days')::interval`;

// $1 days, $2 context id (text), $3 cap.
export const UNIT_HISTORY_SQL = `
    SELECT "tableName", operation, "changedAt", "rowData", "prevData"
      FROM "_history"
     WHERE "changedAt" > ${WINDOW}
       AND (("tableName" = 'ContextMembers' AND "rowId" = $2)
         OR ("tableName" = 'Contexts' AND "rowId" = $2
             AND NOT (operation = 'U' AND ("rowData" - ${NOISE}) IS NOT DISTINCT FROM ("prevData" - ${NOISE})))
         OR ("tableName" = 'ContextRoles' AND "rowData"->>'contextId' = $2)
         OR ("tableName" = 'ChangeRequests' AND "rowData"->>'contextId' = $2)
         OR ("tableName" = 'ContextTreeAdjustments'
             AND $2 IN ("rowData"->>'subjectId', "rowData"->'payload'->>'toUnitId', "rowData"->'payload'->>'fromUnitId',
                        "rowData"->'payload'->>'contextId', "rowData"->'payload'->>'toParentId')))
     ORDER BY "changedAt" DESC
     LIMIT $3`;

// Members in the window that joined before the membership history began.
export const EARLIER_MEMBERS_SQL = `
    SELECT cm."memberType", cm."memberId", cm."addedBy", cm."addedAt"
      FROM "ContextMembers" cm
     WHERE cm."contextId" = $2::text::uuid AND cm."addedBy" <> 'algorithm'
       AND cm."addedAt" > ${WINDOW}
       AND cm."addedAt" < COALESCE((SELECT min(h."changedAt") FROM "_history" h
                                     WHERE h."tableName" = 'ContextMembers' AND h."rowId" = $2::text), 'infinity')
     ORDER BY cm."addedAt" DESC
     LIMIT $3`;

// Where the unit comes from: the names its sync and its rule go by.
export const PROVENANCE_SQL = `
    SELECT s."displayName" AS "systemName", s."systemType", a."displayName" AS "ruleName"
      FROM "Contexts" c
      LEFT JOIN "Systems" s ON s.id = c."scopeSystemId"
      LEFT JOIN "ContextAlgorithms" a ON a.id = c."sourceAlgorithmId"
     WHERE c.id = $1`;

// The accounts of the unit's people: its account members, the accounts of its
// person members, and of the given people who left ($2 accounts, $3 persons).
export const PEOPLE_ACCOUNTS_SQL = `
    SELECT cm."memberId"::text AS id FROM "ContextMembers" cm
     WHERE cm."contextId" = $1 AND cm."memberType" = 'Principal'
    UNION
    SELECT im."principalId"::text FROM "IdentityMembers" im
      JOIN "ContextMembers" cm ON cm."memberType" = 'Identity' AND cm."memberId" = im."identityId"
     WHERE cm."contextId" = $1
    UNION
    SELECT unnest($2::uuid[])::text
    UNION
    SELECT im."principalId"::text FROM "IdentityMembers" im WHERE im."identityId" = ANY($3::uuid[])
    LIMIT ${MAX_PEOPLE_IDS}`;

// $1 days, $2 account ids (text[]), $3 cap.
export const PEOPLE_CHANGES_SQL = `
    SELECT operation, "changedAt", "rowData", "prevData"
      FROM "_history"
     WHERE "tableName" = 'Principals' AND "rowId" = ANY($2::text[]) AND operation = 'U'
       AND "changedAt" > ${WINDOW}
       AND (("rowData"->>'jobTitle') IS DISTINCT FROM ("prevData"->>'jobTitle')
         OR ("rowData"->>'department') IS DISTINCT FROM ("prevData"->>'department')
         OR ("rowData"->>'managerId') IS DISTINCT FROM ("prevData"->>'managerId')
         OR ("rowData"->>'accountEnabled') IS DISTINCT FROM ("prevData"->>'accountEnabled')
         OR ("rowData"->>'deletedAt' IS NULL) <> ("prevData"->>'deletedAt' IS NULL))
     ORDER BY "changedAt" DESC
     LIMIT $3`;

export const NAMES_SQL = `
    SELECT 'Principal' AS kind, id::text AS id, "displayName" FROM "Principals" WHERE id = ANY($1::uuid[])
    UNION ALL SELECT 'Identity', id::text, "displayName" FROM "Identities" WHERE id = ANY($1::uuid[])
    UNION ALL SELECT 'Resource', id::text, "displayName" FROM "Resources" WHERE id = ANY($1::uuid[])
    UNION ALL SELECT 'Context', id::text, "displayName" FROM "Contexts" WHERE id = ANY($1::uuid[])`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The ids a history row names, per table (both sides of an update).
const both = (r, ...keys) => [r.rowData || {}, r.prevData || {}].flatMap(x => keys.map(k => x[k]));
const NAMED_IDS = {
  ContextMembers: (r) => both(r, 'memberId'),
  ContextRoles: (r) => both(r, 'principalId', 'identityId'),
  Contexts: (r) => both(r, 'parentContextId'),
  ContextTreeAdjustments: (r) => {
    const p = r.rowData?.payload || {};
    return [r.rowData?.memberId, p.toParentId, p.toUnitId, p.principalId];
  },
};

/** Every id the rows name, for one name lookup. Pure. */
export function idsNamed(byTable, people, earlier) {
  const all = [
    ...Object.entries(NAMED_IDS).flatMap(([table, of]) => (byTable[table] || []).flatMap(of)),
    ...people.flatMap(r => both(r, 'managerId')),
    ...earlier.map(m => m.memberId),
  ];
  return [...new Set(all.filter(v => typeof v === 'string' && UUID_RE.test(v)))];
}

/** A lookup over the rows of NAMES_SQL. Pure. */
export function nameBook(rows) {
  const byKind = new Map();
  for (const r of rows) byKind.set(`${r.kind}:${r.id}`, r.displayName);
  const of = (kind, id) => (id ? byKind.get(`${kind}:${id}`) ?? null : null);
  const any = (id) => of('Principal', id) || of('Identity', id) || of('Resource', id) || of('Context', id);
  return {
    member: (memberType, id) => of(memberType, id) || any(id),
    any,
    context: (id) => of('Context', id),
    holder: (row) => (row?.principalId ? of('Principal', row.principalId) : of('Identity', row?.identityId)),
  };
}

const TABLES = ['ContextMembers', 'Contexts', 'ContextRoles', 'ChangeRequests', 'ContextTreeAdjustments'];

/** The unit's _history rows by table, oldest first within a table (pairs read in order). Pure. */
export function splitByTable(rows) {
  const out = Object.fromEntries(TABLES.map(t => [t, []]));
  for (const r of [...rows].reverse()) out[r.tableName]?.push(r);
  return out;
}

/**
 * The earlier joins that the membership history does not already tell: a member
 * with a join row of its own is left out (addedAt is stamped in UTC wall time,
 * so in another session timezone it can fall before the first history row). Pure.
 */
export function untoldJoins(earlier, memberRows) {
  const told = new Set(memberRows.filter(r => r.operation === 'I').map(r => r.rowData?.memberId));
  return earlier.filter(m => !told.has(m.memberId));
}

/** Who left in the window: the members a history row took away. Pure. */
export function leavers(memberRows) {
  const principals = [];
  const identities = [];
  for (const r of memberRows) {
    if (r.operation !== 'D') continue;
    const m = r.rowData || {};
    if (m.memberType === 'Principal') principals.push(m.memberId);
    if (m.memberType === 'Identity') identities.push(m.memberId);
  }
  return { principals, identities };
}

export async function loadUnitTimeline(db, contextId, { sinceDays, interviewEvents = async () => [] }) {
  const [history, earlier, provenanceRow, interviews] = await Promise.all([
    db.query(UNIT_HISTORY_SQL, [sinceDays, contextId, UNIT_TIMELINE_ROW_CAP]),
    db.query(EARLIER_MEMBERS_SQL, [sinceDays, contextId, UNIT_TIMELINE_ROW_CAP]),
    db.query(PROVENANCE_SQL, [contextId]),
    interviewEvents(),
  ]);
  const byTable = splitByTable(history.rows);
  const left = leavers(byTable.ContextMembers);
  const accounts = (await db.query(PEOPLE_ACCOUNTS_SQL, [contextId, left.principals, left.identities])).rows.map(r => r.id);
  const people = accounts.length
    ? (await db.query(PEOPLE_CHANGES_SQL, [sinceDays, accounts, UNIT_TIMELINE_ROW_CAP])).rows
    : [];
  const ids = idsNamed(byTable, people, earlier.rows);
  const names = nameBook(ids.length ? (await db.query(NAMES_SQL, [ids])).rows : []);
  const deps = { names, provenance: provenanceRow.rows[0] || {} };

  const events = sortEvents([
    ...membershipEvents(byTable.ContextMembers, deps),
    ...untoldJoins(earlier.rows, byTable.ContextMembers).map(m => membershipEvent({ at: m.addedAt, memberType: m.memberType, memberId: m.memberId, addedBy: m.addedBy, joined: true }, deps)),
    ...roleEvents(byTable.ContextRoles, deps),
    ...contextRowEvents(byTable.Contexts, deps),
    ...changeRequestEvents(byTable.ChangeRequests),
    ...adjustmentEvents(byTable.ContextTreeAdjustments, contextId, deps),
    ...personAttributeEvents(people, deps),
    ...interviews,
  ]);
  const truncated = [history, earlier].some(r => r.rows.length >= UNIT_TIMELINE_ROW_CAP) || people.length >= UNIT_TIMELINE_ROW_CAP;
  return { events, truncated };
}
