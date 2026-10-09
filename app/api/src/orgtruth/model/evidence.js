// Organisation truth — what other lists say about one entity.
//
//   getEvidence(id)          → evidence | null (unknown entity)
//   computeEvidence(input)   → evidence (pure)
//
// One list says who SHOULD be on a customer (its owner, its team); another says
// who REALLY worked for it, and when (timesheet rows that link to the customer
// through their customer column). The evidence puts the two side by side:
//
//   {
//     entity:   { id, entityType, displayName },
//     people:   [{ via, principals: [{ principalId, label, worked, rows, hours, lastPeriod }] }],
//               the entity's own accepted links to accounts, per attribute (eigenaar, team),
//               each marked with whether the referring rows show that person working on it
//     activity: { referrerTypes, rows, hours, firstPeriod, lastPeriod, periods, unlinkedRows } | null,
//               the referring rows taken together: how much, from when to when
//     workedNotListed: [{ principalId, label, rows, hours, lastPeriod }],
//               people the referring rows link to who are in none of `people`
//   }
//
// Generic on purpose: nothing here knows the word "timesheet". A referring row
// is any open, accepted entity of ANOTHER type linked to this one through an
// attribute (link targetType 'OrgEntity', via ≠ displayName). Its hours are the
// sum of its attributes that hold a decimal number; its period comes from an
// attribute holding a year (19xx/20xx) and one holding a month (name or 1–12).
import { query, queryOne } from '../../db/connection.js';
import { parseJsonbColumn } from '../../lib/jsonb.js';

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

const later = (a, b) => (!a || (b && b > a) ? b : a);
const earlier = (a, b) => (!a || (b && b < a) ? b : a);
const round1 = (n) => Math.round(n * 10) / 10;

// Per principal: rows, hours, last period over the referring rows.
function workByPrincipal(referrers, referrerLinks) {
  const principalsOf = new Map();
  for (const l of referrerLinks) {
    const list = principalsOf.get(l.orgEntityId);
    if (list) list.push(l.targetId); else principalsOf.set(l.orgEntityId, [l.targetId]);
  }
  const work = new Map();
  let unlinkedRows = 0;
  for (const r of referrers) {
    const who = principalsOf.get(r.id);
    if (!who) { unlinkedRows += 1; continue; }
    for (const p of who) {
      const w = work.get(p) ?? { rows: 0, hours: 0, lastPeriod: null };
      w.rows += 1;
      w.hours += r.hours;
      w.lastPeriod = later(w.lastPeriod, r.period);
      work.set(p, w);
    }
  }
  return { work, unlinkedRows };
}

function activityOf(referrers, unlinkedRows) {
  if (referrers.length === 0) return null;
  let first = null; let last = null; let hours = 0;
  const periods = new Set();
  for (const r of referrers) {
    hours += r.hours;
    first = earlier(first, r.period);
    last = later(last, r.period);
    if (r.period) periods.add(r.period);
  }
  return {
    referrerTypes: [...new Set(referrers.map(r => r.entityType))],
    rows: referrers.length, hours: round1(hours), firstPeriod: first, lastPeriod: last, periods: periods.size, unlinkedRows,
  };
}

export function computeEvidence({ entity, directLinks, referrers: rawReferrers, referrerLinks, labels }) {
  const referrers = rawReferrers.map(r => {
    const attributes = parseJsonbColumn(r.attributes) ?? {};
    return { id: r.id, entityType: r.entityType, hours: hoursOf(attributes), period: periodOf(attributes) };
  });
  const { work, unlinkedRows } = workByPrincipal(referrers, referrerLinks);
  const label = (id) => labels.get(id) ?? null;

  const byVia = new Map();
  for (const l of directLinks) {
    const list = byVia.get(l.via ?? 'displayName');
    if (list) { if (!list.includes(l.targetId)) list.push(l.targetId); } else byVia.set(l.via ?? 'displayName', [l.targetId]);
  }
  const listed = new Set(directLinks.map(l => l.targetId));
  const people = [...byVia.entries()].map(([via, ids]) => ({
    via,
    principals: ids.map(id => {
      const w = work.get(id);
      return { principalId: id, label: label(id), worked: !!w, rows: w?.rows ?? 0, hours: round1(w?.hours ?? 0), lastPeriod: w?.lastPeriod ?? null };
    }),
  }));
  const workedNotListed = [...work.entries()]
    .filter(([id]) => !listed.has(id))
    .map(([id, w]) => ({ principalId: id, label: label(id), rows: w.rows, hours: round1(w.hours), lastPeriod: w.lastPeriod }))
    .sort((a, b) => b.hours - a.hours);

  return {
    entity: { id: entity.id, entityType: entity.entityType, displayName: entity.displayName },
    people, activity: activityOf(referrers, unlinkedRows), workedNotListed,
  };
}

export async function getEvidence(id) {
  const entity = await queryOne(`SELECT "id", "entityType", "displayName" FROM "OrgEntities" WHERE "id" = $1`, [id]);
  if (!entity) return null;
  const directLinks = (await query(`
    SELECT "via", "targetId" FROM "OrgLinks"
     WHERE "orgEntityId" = $1 AND "status" = 'accepted' AND "targetType" = 'Principal'
     ORDER BY "via", "createdAt"`, [id])).rows;
  const referrers = (await query(`
    SELECT r."id", r."entityType", r."attributes"
      FROM "OrgLinks" l JOIN "OrgEntities" r ON r."id" = l."orgEntityId"
     WHERE l."targetType" = 'OrgEntity' AND l."targetId" = $1 AND l."status" = 'accepted'
       AND l."via" IS DISTINCT FROM 'displayName'
       AND r."status" = 'accepted' AND r."validTo" IS NULL AND r."entityType" <> $2`, [id, entity.entityType])).rows;
  const referrerLinks = referrers.length === 0 ? [] : (await query(`
    SELECT "orgEntityId", "targetId" FROM "OrgLinks"
     WHERE "orgEntityId" = ANY($1::uuid[]) AND "status" = 'accepted' AND "targetType" = 'Principal'`, [referrers.map(r => r.id)])).rows;
  const ids = [...new Set([...directLinks.map(l => l.targetId), ...referrerLinks.map(l => l.targetId)])];
  const labels = new Map(ids.length === 0 ? [] : (await query(
    `SELECT "id", "displayName" FROM "Principals" WHERE "id" = ANY($1::uuid[])`, [ids])).rows.map(r => [r.id, r.displayName]));
  return computeEvidence({ entity, directLinks, referrers, referrerLinks, labels });
}
