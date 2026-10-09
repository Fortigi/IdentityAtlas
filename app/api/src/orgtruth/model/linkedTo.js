// Organisation truth — what the organisation lists say about ONE system object
// (a principal, identity, resource or context): the relationship graph of its
// detail page gets an "Organisation" branch from this.
//
//   getLinkedTo(targetType, id) → { total, groups: [group] }
//   group = { key, entityType, via, kind: 'direct' | 'through', label, count,
//             items: [{ entityId, entityType, label, detail }] }
//
//   direct   org entities linked to the object through an attribute, per
//            (entityType, via): "Klant · eigenaar" (customers this person owns),
//            "Klant · team", "FortigiMaten · name" (the person themselves)
//   through  for rows that are FACTS about the object (a timesheet row linked to
//            this person by name, which itself links to a customer through its
//            customer column): not the 98 rows, but the distinct entities they
//            point at — "Klant · worked on (Uren)" with hours and the last period
//            per customer. Fact rows are recognised by having such a link to
//            another list; their own direct group is left out (they are counted
//            in the `through` group's detail instead).
// A Principal also collects what is linked to the Identity it belongs to, and
// an Identity what is linked to its accounts.
import { query } from '../../db/connection.js';
import { parseJsonbColumn } from '../../lib/jsonb.js';
import { hoursOf, periodOf } from './evidence.js';

export const TARGET_TYPES = ['Principal', 'Identity', 'Resource', 'Context'];
const ITEM_CAP = 200;

// The (targetType, id) pairs to look for: the object itself, plus the identity
// ↔ accounts it is linked with.
async function targetsOf(targetType, id) {
  const pairs = [{ targetType, id }];
  if (targetType === 'Principal') {
    const r = await query(`SELECT "identityId" FROM "IdentityMembers" WHERE "principalId" = $1`, [id]);
    for (const row of r.rows) pairs.push({ targetType: 'Identity', id: row.identityId });
  }
  if (targetType === 'Identity') {
    const r = await query(`SELECT "principalId" FROM "IdentityMembers" WHERE "identityId" = $1`, [id]);
    for (const row of r.rows) pairs.push({ targetType: 'Principal', id: row.principalId });
  }
  return pairs;
}

const directSql = `
  SELECT e."id", e."entityType", e."displayName", e."attributes", COALESCE(l."via", 'displayName') AS via
    FROM "OrgLinks" l JOIN "OrgEntities" e ON e."id" = l."orgEntityId"
   WHERE l."status" = 'accepted' AND l."targetType" = ANY($1::text[]) AND l."targetId" = ANY($2::uuid[])
     AND e."status" = 'accepted' AND e."validTo" IS NULL`;

// For the given org entities: their accepted links to OTHER lists' entities through an attribute.
const throughSql = `
  SELECT l."orgEntityId" AS "fromId", COALESCE(l."via", 'displayName') AS via, t."id", t."entityType", t."displayName"
    FROM "OrgLinks" l JOIN "OrgEntities" t ON t."id" = l."targetId"
   WHERE l."status" = 'accepted' AND l."targetType" = 'OrgEntity' AND COALESCE(l."via", 'displayName') <> 'displayName'
     AND l."orgEntityId" = ANY($1::uuid[]) AND t."status" = 'accepted' AND t."validTo" IS NULL`;

const viaLabel = (via) => (via === 'displayName' ? 'name' : via);

/** Pure: direct rows + through rows → groups. */
export function buildGroups(directRows, throughRows) {
  const factIds = new Set(throughRows.map(r => r.fromId));
  const direct = new Map();
  for (const r of directRows) {
    if (factIds.has(r.id)) continue;
    const key = `direct|${r.entityType}|${r.via}`;
    const g = direct.get(key) ?? { key, entityType: r.entityType, via: r.via, kind: 'direct', label: `${r.entityType} · ${viaLabel(r.via)}`, items: new Map() };
    g.items.set(r.id, { entityId: r.id, entityType: r.entityType, label: r.displayName, detail: null });
    direct.set(key, g);
  }
  const factsById = new Map(directRows.filter(r => factIds.has(r.id)).map(r => [r.id, r]));
  const through = new Map();
  for (const t of throughRows) {
    const fact = factsById.get(t.fromId);
    if (!fact) continue;
    const key = `through|${t.entityType}|${fact.entityType}|${t.via}`;
    const g = through.get(key) ?? { key, entityType: t.entityType, via: t.via, kind: 'through', label: `${t.entityType} · worked on (${fact.entityType})`, items: new Map(), sourceType: fact.entityType };
    const attrs = parseJsonbColumn(fact.attributes) ?? {};
    const item = g.items.get(t.id) ?? { entityId: t.id, entityType: t.entityType, label: t.displayName, rows: 0, hours: 0, lastPeriod: null };
    item.rows += 1;
    item.hours += hoursOf(attrs);
    const p = periodOf(attrs);
    if (p && (!item.lastPeriod || p > item.lastPeriod)) item.lastPeriod = p;
    g.items.set(t.id, item);
    through.set(key, g);
  }
  const finish = (g) => {
    const items = [...g.items.values()].map(i => (g.kind === 'through'
      ? { entityId: i.entityId, entityType: i.entityType, label: i.label, detail: `${Math.round(i.hours * 10) / 10} h · ${i.rows} rows${i.lastPeriod ? ` · until ${i.lastPeriod}` : ''}`, hours: Math.round(i.hours * 10) / 10, lastPeriod: i.lastPeriod }
      : i));
    items.sort((a, b) => (b.hours ?? 0) - (a.hours ?? 0) || String(a.label).localeCompare(String(b.label)));
    const { items: _i, ...rest } = g;
    return { ...rest, count: items.length, items: items.slice(0, ITEM_CAP), truncated: items.length > ITEM_CAP };
  };
  const groups = [...direct.values(), ...through.values()].map(finish).sort((a, b) => a.label.localeCompare(b.label));
  return { total: groups.reduce((n, g) => n + g.count, 0), groups };
}

export async function getLinkedTo(targetType, id) {
  const pairs = await targetsOf(targetType, id);
  const directRows = (await query(directSql, [pairs.map(p => p.targetType), pairs.map(p => p.id)])).rows;
  const ids = directRows.map(r => r.id);
  const throughRows = ids.length === 0 ? [] : (await query(throughSql, [ids])).rows;
  return buildGroups(directRows, throughRows);
}
