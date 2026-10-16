// Organisation truth — what other lists say about one entity.
//
//   getEvidence(id)          → evidence | null (unknown entity)
//   computeEvidence(input)   → evidence (pure)
//
// One list says who SHOULD be on a customer (its owner, its team); an activity
// list (T10, OrgActivities: a timesheet) says who REALLY worked for it, and when.
// The evidence puts the two side by side:
//
//   {
//     entity:   { id, entityType, displayName },
//     people:   [{ via, principals: [{ principalId, label, worked, rows, hours, lastPeriod }] }],
//               the entity's own accepted links to accounts, per attribute (eigenaar, team),
//               each marked with whether the activity shows that person working on it
//     activity: { referrerTypes, rows, hours, firstPeriod, lastPeriod, periods, unlinkedRows } | null,
//               the activity rows on this entity taken together: how much, from when to when
//               (referrerTypes = the activity types; periods = distinct months)
//     workedNotListed: [{ principalId, targetType, label, rows, hours, lastPeriod }],
//               people the activity names who are in none of `people` (principalId is the
//               resolved record's id, targetType says whether that is a Principal or an Identity)
//   }
//
// Only accepted activity keys count. A row whose subject key resolves to this
// entity but whose actor key does not is an unlinked row. An activity naming
// a person's identity (or another account of theirs) counts for the listed
// account (identity ↔ accounts, activity/family.js). Hours are the sum of the
// rows' measure; a period is the month (YYYY-MM) of occurredOn.
//
// monthOf / periodOf / hoursOf read the year, month and hours out of a raw row's
// cells; the activity import reuses them.
import { query, queryOne } from '../../db/connection.js';
import { resolveLabels } from './entities.js';
import { activityRollupSql, later, earlier } from '../activity/sql.js';
import { loadFamily, keyOf } from '../activity/family.js';

const MONTHS = ['januari|january|jan', 'februari|february|feb', 'maart|march|mrt|mar', 'april|apr', 'mei|may',
  'juni|june|jun', 'juli|july|jul', 'augustus|august|aug', 'september|sep|sept', 'oktober|october|okt|oct',
  'november|nov', 'december|dec'].map(alts => new Set(alts.split('|')));
const DECIMAL = /^-?\d+([.,]\d+)$/;
const YEAR = /^(19|20)\d\d$/;

/** 1..12 for a month name (nl/en) or number, else null. */
export function monthOf(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (/^\d{1,2}$/.test(s)) { const n = Number(s); return n >= 1 && n <= 12 ? n : null; }
  const i = MONTHS.findIndex(set => set.has(s));
  return i < 0 ? null : i + 1;
}

/** 'YYYY-MM' from an attribute bag, or null when it holds no year. */
export function periodOf(attributes) {
  const values = Object.values(attributes ?? {}).map(v => String(v ?? '').trim());
  const year = values.find(v => YEAR.test(v));
  if (!year) return null;
  const month = values.map(monthOf).find(m => m !== null && m !== undefined);
  return `${year}-${String(month ?? 1).padStart(2, '0')}`;
}

/** Sum of the attributes holding a decimal number ("52,00" → 52). */
export function hoursOf(attributes) {
  let sum = 0;
  for (const v of Object.values(attributes ?? {})) {
    const s = String(v ?? '').trim();
    if (DECIMAL.test(s)) sum += Number(s.replace(',', '.'));
  }
  return sum;
}

const round1 = (n) => Math.round(n * 10) / 10;
const periodOfRow = (r) => r.month ?? (r.lastOn ? r.lastOn.slice(0, 7) : null);

// Per resolved actor: rows, hours, last period.
function workByActor(activities) {
  const work = new Map();
  for (const r of activities) {
    if (!r.actorId) continue;
    const k = keyOf(r.actorType, r.actorId);
    const w = work.get(k) ?? { targetType: r.actorType, targetId: r.actorId, rows: 0, hours: 0, lastPeriod: null };
    w.rows += r.rowCount;
    w.hours += r.total;
    w.lastPeriod = later(w.lastPeriod, periodOfRow(r));
    work.set(k, w);
  }
  return [...work.values()];
}

function activityOf(activities) {
  if (activities.length === 0) return null;
  let first = null; let last = null; let hours = 0; let rows = 0; let unlinkedRows = 0;
  const periods = new Set();
  for (const r of activities) {
    const p = periodOfRow(r);
    hours += r.total;
    rows += r.rowCount;
    if (!r.actorId) unlinkedRows += r.rowCount;
    first = earlier(first, p);
    last = later(last, p);
    if (p) periods.add(p);
  }
  return {
    referrerTypes: [...new Set(activities.map(r => r.activityType))],
    rows, hours: round1(hours), firstPeriod: first, lastPeriod: last, periods: periods.size, unlinkedRows,
  };
}

// The work of every actor that is (a record of) the listed principal.
function workOf(principalId, work, family) {
  const mine = work.filter(w => family(w.targetType, w.targetId).has(keyOf('Principal', principalId)));
  if (mine.length === 0) return null;
  return mine.reduce((acc, w) => ({ rows: acc.rows + w.rows, hours: acc.hours + w.hours, lastPeriod: later(acc.lastPeriod, w.lastPeriod) }),
    { rows: 0, hours: 0, lastPeriod: null });
}

function viaGroups(directLinks) {
  const byVia = new Map();
  for (const l of directLinks) {
    const via = l.via ?? 'displayName';
    const list = byVia.get(via) ?? [];
    if (!list.includes(l.targetId)) list.push(l.targetId);
    byVia.set(via, list);
  }
  return byVia;
}

/**
 * @param {{ entity, directLinks: {via, targetId}[], activities: object[], family: Function, labels: Map }} input
 *   activities = roll-up rows of activity/sql.js (byMonth) for this entity as subject;
 *   labels keyed 'Type:id' (entities.resolveLabels)
 */
export function computeEvidence({ entity, directLinks, activities, family, labels }) {
  const work = workByActor(activities);
  const label = (type, id) => labels.get(keyOf(type, id))?.label ?? null;
  const people = [...viaGroups(directLinks).entries()].map(([via, ids]) => ({
    via,
    principals: ids.map(id => {
      const w = workOf(id, work, family);
      return { principalId: id, label: label('Principal', id), worked: !!w, rows: w?.rows ?? 0, hours: round1(w?.hours ?? 0), lastPeriod: w?.lastPeriod ?? null };
    }),
  }));
  const listed = new Set(directLinks.map(l => keyOf('Principal', l.targetId)));
  const workedNotListed = work
    .filter(w => ![...family(w.targetType, w.targetId)].some(k => listed.has(k)))
    .map(w => ({ principalId: w.targetId, targetType: w.targetType, label: label(w.targetType, w.targetId), rows: w.rows, hours: round1(w.hours), lastPeriod: w.lastPeriod }))
    .sort((a, b) => b.hours - a.hours);
  return {
    entity: { id: entity.id, entityType: entity.entityType, displayName: entity.displayName },
    people, activity: activityOf(activities), workedNotListed,
  };
}

const activitySql = activityRollupSql(`sk."targetType" = 'OrgEntity' AND sk."targetId" = $1`, { byMonth: true });

export async function getEvidence(id) {
  const entity = await queryOne(`SELECT "id", "entityType", "displayName" FROM "OrgEntities" WHERE "id" = $1`, [id]);
  if (!entity) return null;
  const directLinks = (await query(`
    SELECT "via", "targetId" FROM "OrgLinks"
     WHERE "orgEntityId" = $1 AND "status" = 'accepted' AND "targetType" = 'Principal'
     ORDER BY "via", "createdAt"`, [id])).rows;
  const activities = (await query(activitySql, [id])).rows;
  const refs = [
    ...directLinks.map(l => ({ targetType: 'Principal', targetId: l.targetId })),
    ...activities.filter(r => r.actorId).map(r => ({ targetType: r.actorType, targetId: r.actorId })),
  ];
  const family = await loadFamily(refs);
  const labels = await resolveLabels(refs);
  return computeEvidence({ entity, directLinks, activities, family, labels });
}
