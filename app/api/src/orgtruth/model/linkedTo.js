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
//            "Klant · team", "Maten · name" (the person themselves)
//   through  what the person WORKED ON according to an activity list (T10,
//            OrgActivities): not the rows, but the distinct subjects they point at
//            — "Klant · worked on (Uren)" with hours (sum of measure) and the last
//            period (YYYY-MM) per customer. Only accepted actor and subject keys
//            count; the person's rows whose subject is unresolved are counted on
//            the group as `unlinkedRows`. Through groups also carry
//            `sourceType` (the activity type) and `via: 'subject'`; their items
//            carry `hours` and `lastPeriod`.
// A Principal also collects what is linked to the Identity it belongs to, and
// an Identity what is linked to its accounts.
import { query } from '../../db/connection.js';
import { activityRollupSql, later } from '../activity/sql.js';

export const TARGET_TYPES = ['Principal', 'Identity', 'Resource', 'Context'];
const ITEM_CAP = 200;
const ACTOR_TYPES = new Set(['Principal', 'Identity']);

// The (targetType, id) pairs to look for: the object itself, plus the identity
// ↔ accounts it is linked with.
export async function targetsOf(targetType, id) {
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

// The person's activity rows (accepted actor keys), per activity type and subject.
const activitySql = activityRollupSql(`ak."targetType" = ANY($1::text[]) AND ak."targetId" = ANY($2::uuid[])`);

const viaLabel = (via) => (via === 'displayName' ? 'name' : via);
const round1 = (n) => Math.round(n * 10) / 10;

function directGroups(directRows) {
  const direct = new Map();
  for (const r of directRows) {
    const key = `direct|${r.entityType}|${r.via}`;
    const g = direct.get(key) ?? { key, entityType: r.entityType, via: r.via, kind: 'direct', label: `${r.entityType} · ${viaLabel(r.via)}`, items: new Map() };
    g.items.set(r.id, { entityId: r.id, entityType: r.entityType, label: r.displayName, detail: null });
    direct.set(key, g);
  }
  return direct;
}

function addThroughRow(through, a) {
  const entityType = a.subjectEntityType ?? a.subjectType;
  const key = `through|${entityType}|${a.activityType}`;
  const g = through.get(key) ?? {
    key, entityType, via: 'subject', kind: 'through', label: `${entityType} · worked on (${a.activityType})`, items: new Map(), sourceType: a.activityType,
  };
  const item = g.items.get(a.subjectId) ?? { entityId: a.subjectId, entityType, label: a.subjectLabel ?? null, rows: 0, hours: 0, lastPeriod: null };
  item.rows += a.rowCount;
  item.hours += a.total;
  item.lastPeriod = later(item.lastPeriod, a.lastOn ? a.lastOn.slice(0, 7) : null);
  g.items.set(a.subjectId, item);
  through.set(key, g);
}

function throughItem(i) {
  const hours = round1(i.hours);
  const until = i.lastPeriod ? ` · until ${i.lastPeriod}` : '';
  return { entityId: i.entityId, entityType: i.entityType, label: i.label, detail: `${hours} h · ${i.rows} rows${until}`, hours, lastPeriod: i.lastPeriod };
}

/**
 * Pure: direct rows + activity roll-up rows (orgtruth/activity/sql.js) → groups.
 */
export function buildGroups(directRows, activityRows = []) {
  const direct = directGroups(directRows);
  const through = new Map();
  const unlinked = new Map();
  for (const a of activityRows) {
    if (a.subjectId) addThroughRow(through, a);
    else unlinked.set(a.activityType, (unlinked.get(a.activityType) ?? 0) + a.rowCount);
  }
  const finish = (g) => {
    const items = [...g.items.values()].map(i => (g.kind === 'through' ? throughItem(i) : i));
    items.sort((a, b) => (b.hours ?? 0) - (a.hours ?? 0) || String(a.label).localeCompare(String(b.label)));
    const { items: _i, ...rest } = g;
    const extra = g.kind === 'through' ? { unlinkedRows: unlinked.get(g.sourceType) ?? 0 } : {};
    return { ...rest, ...extra, count: items.length, items: items.slice(0, ITEM_CAP), truncated: items.length > ITEM_CAP };
  };
  const groups = [...direct.values(), ...through.values()].map(finish).sort((a, b) => a.label.localeCompare(b.label));
  return { total: groups.reduce((n, g) => n + g.count, 0), groups };
}

export async function getLinkedTo(targetType, id) {
  const pairs = await targetsOf(targetType, id);
  const types = pairs.map(p => p.targetType);
  const ids = pairs.map(p => p.id);
  const directRows = (await query(directSql, [types, ids])).rows;
  const activityRows = ACTOR_TYPES.has(targetType) ? (await query(activitySql, [types, ids])).rows : [];
  return buildGroups(directRows, activityRows);
}
