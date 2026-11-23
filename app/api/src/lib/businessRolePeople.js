// The people a business role's policies name: approvers, reviewers and who may
// request it (AssignmentPolicies.participants, migration 115).
//
// A named approver or reviewer is Responsible for the role. That is read from
// the policies each time rather than copied, so it cannot go stale when the
// source changes an approver. A relative one ("the person's manager") is shown
// but is nobody in particular, so it makes no one Responsible.
//
// A request scope is linked to a context only on an exact match: a group whose
// members are exactly a context's, or a rule that is one department. Anything
// looser would present a guess as a fact.

import * as db from '../db/connection.js';

export const PARTICIPATIONS = Object.freeze(['Approver', 'Reviewer', 'Requestor']);
const STRICT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEPARTMENT_RULE = /^\(?\s*user\.department\s+-eq\s+"([^"]+)"\s*\)?$/i;

const uuidOrNull = (v) => (typeof v === 'string' && STRICT_UUID.test(v) ? v.toLowerCase() : null);

export function departmentOfRule(rule) {
  return DEPARTMENT_RULE.exec(String(rule ?? '').trim())?.[1] ?? null;
}

// One stored entry, cleaned. Null for one that is not a participant.
export function normalizeParticipant(raw, policy) {
  if (!raw || typeof raw !== 'object' || !PARTICIPATIONS.includes(raw.participation)) return null;
  return {
    policyId: policy.id,
    policyName: policy.displayName ?? null,
    participation: raw.participation,
    subjectType: typeof raw.subjectType === 'string' ? raw.subjectType : 'Other',
    principalId: uuidOrNull(raw.principalId),
    groupId: uuidOrNull(raw.groupId),
    rule: raw.rule ?? null,
    managerLevel: raw.managerLevel ?? null,
    displayName: raw.displayName ?? null,
    isFallback: raw.isFallback === true,
    onBehalf: raw.onBehalf === true,
    stage: Number.isInteger(raw.stage) ? raw.stage : 0,
  };
}

export function readParticipants(policies) {
  return policies.flatMap(p => (Array.isArray(p.participants) ? p.participants : [])
    .map(raw => normalizeParticipant(raw, p))
    .filter(Boolean));
}

async function namesOf(table, ids) {
  if (ids.length === 0) return new Map();
  const { rows } = await db.query(`SELECT id, "displayName" FROM "${table}" WHERE id = ANY($1::uuid[])`, [ids]);
  return new Map(rows.map(r => [r.id, r.displayName]));
}

// The one context with exactly this group's members; none when two have them.
async function contextOfGroup(groupId) {
  const { rows: members } = await db.query(`
    SELECT DISTINCT "principalId" AS id FROM "ResourceAssignments"
     WHERE "resourceId" = $1 AND "principalId" IS NOT NULL AND "assignmentType" = 'Direct' AND "deletedAt" IS NULL
  `, [groupId]);
  if (members.length === 0) return null;
  const ids = members.map(m => m.id);
  const { rows } = await db.query(`
    SELECT c.id, c."displayName"
      FROM "Contexts" c
      JOIN "ContextMembers" cm ON cm."contextId" = c.id AND cm."memberType" = 'Principal'
     WHERE c.id IN (SELECT "contextId" FROM "ContextMembers" WHERE "memberType" = 'Principal' AND "memberId" = $1)
     GROUP BY c.id, c."displayName"
    HAVING COUNT(*) = $2 AND COUNT(*) FILTER (WHERE cm."memberId" = ANY($3::uuid[])) = $2
     LIMIT 2
  `, [ids[0], ids.length, ids]);
  return rows.length === 1 ? rows[0] : null;
}

async function contextOfDepartment(name) {
  const { rows } = await db.query(`
    SELECT id, "displayName" FROM "Contexts"
     WHERE "contextType" = 'Department' AND lower("displayName") = lower($1) LIMIT 2
  `, [name]);
  return rows.length === 1 ? rows[0] : null;
}

async function contextOfScope(p) {
  if (p.subjectType === 'Group' && p.groupId) return contextOfGroup(p.groupId);
  const department = p.subjectType === 'Rule' ? departmentOfRule(p.rule) : null;
  return department ? contextOfDepartment(department) : null;
}

export async function loadParticipants(resourceId) {
  const { rows } = await db.query(
    `SELECT id, "displayName", participants FROM "AssignmentPolicies" WHERE "resourceId" = $1 ORDER BY "displayName"`,
    [resourceId],
  );
  const list = readParticipants(rows);
  const people = await namesOf('Principals', [...new Set(list.map(p => p.principalId).filter(Boolean))]);
  const groups = await namesOf('Resources', [...new Set(list.map(p => p.groupId).filter(Boolean))]);
  const out = [];
  for (const p of list) {
    const name = people.get(p.principalId) ?? groups.get(p.groupId) ?? p.displayName;
    const context = p.participation === 'Requestor' ? await contextOfScope(p) : null;
    out.push({ ...p, displayName: name, contextId: context?.id ?? null, contextName: context?.displayName ?? null });
  }
  return out;
}

// principalId → { displayName, derivedFrom } for every named approver and reviewer.
export function namedResponsible(participants) {
  const named = new Map();
  for (const p of participants) {
    if (p.participation === 'Requestor' || p.subjectType !== 'User' || !p.principalId) continue;
    const entry = named.get(p.principalId) ?? { displayName: p.displayName, derivedFrom: [] };
    if (!entry.derivedFrom.includes(p.participation)) entry.derivedFrom.push(p.participation);
    named.set(p.principalId, entry);
  }
  return named;
}

// The stored owners plus the Responsible the policies name. Those carry an id
// starting with "policy:": they change in the source, not here.
export function withPolicyResponsible(owners, participants) {
  const named = namedResponsible(participants);
  const merged = owners.map((o) => {
    const hit = o.role === 'Responsible' ? named.get(o.principalId) : null;
    return hit ? { ...o, derivedFrom: hit.derivedFrom } : o;
  });
  const stored = new Set(owners.filter(o => o.role === 'Responsible').map(o => o.principalId));
  for (const [principalId, entry] of named) {
    if (stored.has(principalId)) continue;
    merged.push({
      id: `policy:${principalId}`, role: 'Responsible', principalId, identityId: null,
      addedBy: 'policy', displayName: entry.displayName, derivedFrom: entry.derivedFrom,
    });
  }
  return merged;
}
