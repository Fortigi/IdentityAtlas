// Organisation knowledge extraction — does the data we already have say the same?
//
//   sideTargets(links, resolution)   → { state, targets }        (pure) what a mention stands for
//   corroborate(statement, subj, obj) → { verdict, kind, detail } | null
//   rescoreSource(sourceId)           → { scored, corroborated, contradicted }  writes confidence + attributes
//
// A mention stands for an object when a reviewer CONFIRMED a link ('confirmed'), or
// when matching found one clear candidate ('clear': not ambiguous, ≥ CLEAR_AT).
// Only then is a statement checked against the data, per kind of object:
//   person → group (Resource)      a direct or inherited assignment          memberOf
//   person → context               context membership                        memberOf
//   person → list entity           the entity is linked to the person (a team
//                                  member on a customer list) or the person's
//                                  activity points at it (hours on a customer)  memberOf / worksForCustomer
//   person → role named like a list ("maat" ↔ the list "Maten")
//                                  the person is linked from an entity of that list  memberOf
// A membership the directory does NOT have is 'contradicted' — the same fact as the
// directory-gap review question, seen from the statement.
import { query } from '../../db/connection.js';
import { targetsOf } from '../model/linkedTo.js';
import { labelKey } from './evidence.js';
import { scoreStatement } from './confidence.js';
import { VIA } from './store.js';

export const CLEAR_AT = 75;
const PERSON = new Set(['Identity', 'Principal']);
const CHECKED = new Set(['memberOf', 'worksForCustomer', 'leads']);
const RESOLVABLE = new Set(['person', 'team', 'customer', 'organisation', 'application', 'role', 'location']);

/** @param {{ status, analystOverride, targetType, targetId, confidence }[]} links  one mention's links */
export function sideTargets(links, resolution, mentionType) {
  if (!RESOLVABLE.has(mentionType)) return { state: 'none', targets: [] };
  const live = links.filter(l => l.status !== 'rejected');
  const confirmed = live.filter(l => l.status === 'accepted');
  if (confirmed.length) return { state: 'confirmed', targets: confirmed };
  if (live.length === 0) return { state: 'unmatched', targets: [] };
  if (resolution === 'ambiguous') return { state: 'ambiguous', targets: [] };
  const top = Math.max(...live.map(l => l.confidence));
  if (top < CLEAR_AT) return { state: 'unmatched', targets: [] };
  return { state: 'clear', targets: live.filter(l => l.confidence === top) };
}

// Dutch/English plural and vowel doubling folded: "Maten" and "maat" both become "mat".
export const stem = (s) => labelKey(s).replace(/(en|s|n)$/, '').replace(/([aeiou])\1/g, '$1');

export async function rescoreForMention(entityId) {
  const r = await query(`SELECT "sourceId" FROM "OrgEntities" WHERE "id" = $1`, [entityId]);
  return r.rows[0] ? rescoreSource(r.rows[0].sourceId) : null;
}

async function personPrincipals(targets) {
  const ids = new Set();
  const identities = new Set();
  for (const t of targets.filter(x => PERSON.has(x.targetType))) {
    for (const p of await targetsOf(t.targetType, t.targetId)) (p.targetType === 'Principal' ? ids : identities).add(p.id);
  }
  return { principals: [...ids], identities: [...identities] };
}

async function inGroup(person, groupId) {
  if (person.principals.length === 0) return null;
  const r = await query(`SELECT 1 FROM "ResourceAssignments" WHERE "resourceId" = $1 AND "principalId" = ANY($2::uuid[]) LIMIT 1`, [groupId, person.principals]);
  return r.rows.length > 0;
}

async function inContext(person, contextId) {
  const r = await query(`SELECT 1 FROM "ContextMembers" WHERE "contextId" = $1
    AND (("memberType" = 'Principal' AND "memberId" = ANY($2::uuid[])) OR ("memberType" = 'Identity' AND "memberId" = ANY($3::uuid[]))) LIMIT 1`,
  [contextId, person.principals, person.identities]);
  return r.rows.length > 0;
}

// An accepted link from the list entity (or any entity of a list type) to the person.
async function linkedFromList(person, { entityId = null, entityType = null }) {
  const r = await query(`SELECT e."entityType", e."displayName" FROM "OrgLinks" l JOIN "OrgEntities" e ON e."id" = l."orgEntityId"
    WHERE l."status" = 'accepted' AND COALESCE(l."via", '') <> $5 AND e."status" = 'accepted' AND e."validTo" IS NULL
      AND (($1::uuid IS NOT NULL AND e."id" = $1) OR ($2::text IS NOT NULL AND e."entityType" = $2))
      AND ((l."targetType" = 'Principal' AND l."targetId" = ANY($3::uuid[])) OR (l."targetType" = 'Identity' AND l."targetId" = ANY($4::uuid[])))
    LIMIT 1`, [entityId, entityType, person.principals, person.identities, VIA]);
  return r.rows[0] ?? null;
}

async function activityOn(person, entityId) {
  const r = await query(`SELECT count(*)::int AS n FROM "OrgActivities" a
      JOIN "OrgActivityKeys" ak ON ak."id" = a."actorKeyId" AND ak."status" = 'accepted'
      JOIN "OrgActivityKeys" sk ON sk."id" = a."subjectKeyId" AND sk."status" = 'accepted'
     WHERE sk."targetType" = 'OrgEntity' AND sk."targetId" = $1
       AND ((ak."targetType" = 'Principal' AND ak."targetId" = ANY($2::uuid[])) OR (ak."targetType" = 'Identity' AND ak."targetId" = ANY($3::uuid[])))`,
  [entityId, person.principals, person.identities]);
  return r.rows[0]?.n ?? 0;
}

const yes = (kind, detail) => ({ verdict: 'corroborated', kind, detail });

async function checkGroup(person, t) {
  const member = await inGroup(person, t.targetId);
  if (member === null) return null;
  return member ? yes('directory', `member of the group "${t.label}"`) : { verdict: 'contradicted', kind: 'directory', detail: `not a member of the group "${t.label}"` };
}

async function checkListEntity(predicate, person, t) {
  if (await linkedFromList(person, { entityId: t.targetId })) return yes('list', `linked to "${t.label}" in an imported list`);
  const hours = predicate === 'worksForCustomer' ? await activityOn(person, t.targetId) : 0;
  return hours > 0 ? yes('activity', `${hours} activity rows on "${t.label}"`) : null;
}

async function checkTarget(predicate, person, t) {
  if (t.targetType === 'Resource' && predicate === 'memberOf') return checkGroup(person, t);
  if (t.targetType === 'Context' && predicate === 'memberOf') return (await inContext(person, t.targetId)) ? yes('context', `member of the context "${t.label}"`) : null;
  if (t.targetType === 'OrgEntity') return checkListEntity(predicate, person, t);
  return null;
}

/** subj/obj: { mentionType, label, targets } as resolved by sideTargets (with labels). */
export async function corroborate(statement, subj, obj, listTypes = []) {
  if (!CHECKED.has(statement.predicate) || !subj.targets.some(t => PERSON.has(t.targetType))) return null;
  const person = await personPrincipals(subj.targets);
  for (const t of obj.targets) {
    const found = await checkTarget(statement.predicate, person, t);
    if (found) return found;
  }
  // "maat" / "aspirant-maat" ↔ a list called "Maten": membership of the list itself
  const list = statement.predicate === 'memberOf' && listTypes.find(type => stem(type) === stem(obj.label));
  if (list) {
    const hit = await linkedFromList(person, { entityType: list });
    if (hit) return yes('list', `on the imported list "${list}" (as ${hit.displayName})`);
  }
  return null;
}

const STATEMENTS_SQL = `
  SELECT r."id", r."predicate", r."status", r."attributes", r."fromEntityId", r."toEntityId"
    FROM "OrgRelations" r WHERE r."sourceId" = $1 AND r."attributes" ? 'claimKey'`;
const MENTIONS_SQL = `SELECT "id", "displayName", "attributes" FROM "OrgEntities" WHERE "sourceId" = $1 AND "origin" = 'model'`;
const LINKS_SQL = `SELECT "orgEntityId", "targetType", "targetId", "confidence", "status", "analystOverride" FROM "OrgLinks"
  WHERE "orgEntityId" = ANY($1::uuid[]) AND "via" = $2`;
const LIST_TYPES_SQL = `SELECT DISTINCT "entityType" FROM "OrgEntities" WHERE "origin" = 'import' AND "status" = 'accepted' AND "validTo" IS NULL`;

async function labelTargets(links) {
  const out = [];
  for (const l of links) {
    const table = { Identity: 'Identities', Principal: 'Principals', Resource: 'Resources', Context: 'Contexts', OrgEntity: 'OrgEntities' }[l.targetType];
    const row = table ? (await query(`SELECT "displayName" FROM "${table}" WHERE "id" = $1`, [l.targetId])).rows[0] : null;
    out.push({ ...l, label: row?.displayName ?? null });
  }
  return out;
}

/** Recompute confidence and corroboration for every statement of one transcript. */
export async function rescoreSource(sourceId) {
  const statements = (await query(STATEMENTS_SQL, [sourceId])).rows;
  const mentions = new Map((await query(MENTIONS_SQL, [sourceId])).rows.map(m => [m.id, m]));
  const links = mentions.size ? (await query(LINKS_SQL, [[...mentions.keys()], VIA])).rows : [];
  const listTypes = (await query(LIST_TYPES_SQL)).rows.map(r => r.entityType);
  const sides = new Map();
  for (const m of mentions.values()) {
    const s = sideTargets(links.filter(l => l.orgEntityId === m.id), m.attributes?.resolution, m.attributes?.mentionType);
    sides.set(m.id, { ...s, mentionType: m.attributes?.mentionType, label: m.displayName, targets: await labelTargets(s.targets) });
  }
  const counts = { scored: 0, corroborated: 0, contradicted: 0 };
  for (const st of statements) {
    const subj = sides.get(st.fromEntityId) ?? { state: 'none', targets: [] };
    const obj = sides.get(st.toEntityId) ?? { state: 'none', targets: [] };
    const corroboration = await corroborate(st, subj, obj, listTypes);
    const { confidence, parts } = scoreStatement({ support: st.attributes?.support, modality: st.attributes?.modality, sides: [subj.state, obj.state], corroboration });
    const attrs = { ...st.attributes, confidenceParts: parts, corroboration };
    await query(`UPDATE "OrgRelations" SET "confidence" = $2, "attributes" = $3 WHERE "id" = $1`, [st.id, confidence, JSON.stringify(attrs)]);
    counts.scored += 1;
    if (corroboration?.verdict === 'corroborated') counts.corroborated += 1;
    if (corroboration?.verdict === 'contradicted') counts.contradicted += 1;
  }
  return counts;
}
