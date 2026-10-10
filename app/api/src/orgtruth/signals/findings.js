// Organisation truth — the four activity signals for one collection type (pure).
//
//   computeFindings({ entities, activity, members, family, labels, settings }) →
//   { asOf, findings: {
//       inactive:                [{ entityId, label, lastActivityOn, monthsSince }],
//       markedInactiveButActive: [{ entityId, label, statusValue, lastActivityOn }],
//       activeWithoutMembership: [{ entityId, label, actor: { targetType, targetId, label }, total, lastOn }],
//       memberWithoutActivity:   [{ entityId, label, member: { targetType, targetId, label }, role, lastOn }] } }
//
// asOf is the LATEST activity date in the data of this type, not today: an export
// that ends in September still reads sensibly in December, instead of every
// customer turning "inactive" the longer the file sits. Dates are YYYY-MM-DD; a
// period-based activity (monthly hours) is dated on its period's first day.
//
// "Active within the period" = the last activity is fewer than
// settings.inactiveAfterMonths calendar months before asOf (months counted
// calendar-wise: March → September is 6). Per collection entity:
//   inactive                 not active (never any activity: lastActivityOn and
//                            monthsSince null) and NOT marked inactive in the list
//                            itself — an archived customer without activity is expected
//   markedInactiveButActive  marked inactive (statusAttribute holds one of
//                            inactiveValues, trimmed, case-insensitive) yet active
//   activeWithoutMembership  a resolved person with activity on it within the period
//                            who holds no member link to it (any via, any record of
//                            the same person); total over all their rows on it
//   memberWithoutActivity    a member link (role = its via) whose person has no
//                            activity on it within the period (lastOn null = never);
//                            entities marked inactive are skipped
// Unresolved actors count for the entity's own last activity, never for a person.
import { keyOf, membershipIndex } from '../activity/family.js';
import { later, round2 } from '../activity/sql.js';

/** Calendar months from `date` to `asOf` (both YYYY-MM-DD); null when either is missing. */
export function monthsBetween(asOf, date) {
  if (!asOf || !date) return null;
  const m = (d) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7));
  return m(asOf) - m(date);
}

/** Pure: the status attribute value if it marks the entity inactive, else undefined. */
export function inactiveMark(attributes, settings) {
  if (!settings.statusAttribute) return undefined;
  const raw = attributes?.[settings.statusAttribute];
  const wanted = new Set(settings.inactiveValues.map(v => v.trim().toLowerCase()));
  const values = Array.isArray(raw) ? raw : [raw];
  return values.some(v => v !== null && v !== undefined && wanted.has(String(v).trim().toLowerCase())) ? raw : undefined;
}

// Per entity: its last activity date (any actor) and per resolved actor: total + last date.
function activityByEntity(activity) {
  const out = new Map();
  for (const r of activity) {
    const e = out.get(r.subjectId) ?? { lastOn: null, actors: new Map() };
    e.lastOn = later(e.lastOn, r.lastOn);
    if (r.actorId) {
      const k = keyOf(r.actorType, r.actorId);
      const a = e.actors.get(k) ?? { targetType: r.actorType, targetId: r.actorId, total: 0, lastOn: null };
      a.total += r.total;
      a.lastOn = later(a.lastOn, r.lastOn);
      e.actors.set(k, a);
    }
    out.set(r.subjectId, e);
  }
  return out;
}

function groupBy(rows, key) {
  const out = new Map();
  for (const r of rows) { const list = out.get(r[key]) ?? []; list.push(r); out.set(r[key], list); }
  return out;
}

const person = (labels, targetType, targetId) => ({ targetType, targetId, label: labels.get(keyOf(targetType, targetId))?.label ?? null });

// Last activity of the member (any record of them) among the entity's actors.
function memberLastOn(member, actors, family) {
  const mine = family(member.targetType, member.targetId);
  let lastOn = null;
  for (const a of actors.values()) {
    if ([...family(a.targetType, a.targetId)].some(k => mine.has(k))) lastOn = later(lastOn, a.lastOn);
  }
  return lastOn;
}

function actorFindings(ctx, base, act, members) {
  const rolesOf = membershipIndex(members, ctx.family);
  for (const a of act.actors.values()) {
    if (ctx.within(a.lastOn) && rolesOf(a.targetType, a.targetId).length === 0) {
      ctx.out.activeWithoutMembership.push({ ...base, actor: person(ctx.labels, a.targetType, a.targetId), total: round2(a.total), lastOn: a.lastOn });
    }
  }
}

function memberFindings(ctx, base, act, members) {
  const seen = new Set();
  for (const m of members) {
    const k = `${keyOf(m.targetType, m.targetId)}|${m.via}`;
    const lastOn = memberLastOn(m, act.actors, ctx.family);
    if (seen.has(k) || ctx.within(lastOn)) continue;
    seen.add(k);
    ctx.out.memberWithoutActivity.push({ ...base, member: person(ctx.labels, m.targetType, m.targetId), role: m.via, lastOn });
  }
}

function entityFindings(ctx, entity) {
  const { settings, asOf, out } = ctx;
  const act = ctx.byEntity.get(entity.id) ?? { lastOn: null, actors: new Map() };
  const base = { entityId: entity.id, label: entity.displayName };
  const mark = inactiveMark(entity.attributes, settings);
  const marked = mark !== undefined;
  const active = ctx.within(act.lastOn);
  if (!active && !marked) out.inactive.push({ ...base, lastActivityOn: act.lastOn, monthsSince: monthsBetween(asOf, act.lastOn) });
  if (active && marked) out.markedInactiveButActive.push({ ...base, statusValue: mark, lastActivityOn: act.lastOn });
  const members = ctx.membersByEntity.get(entity.id) ?? [];
  actorFindings(ctx, base, act, members);
  if (!marked) memberFindings(ctx, base, act, members);
}

const byLabel = (a, b) => String(a.label).localeCompare(String(b.label));

export function computeFindings({ entities, activity, members, family, labels, settings }) {
  const asOf = activity.reduce((max, r) => later(max, r.lastOn), null);
  const out = { inactive: [], markedInactiveButActive: [], activeWithoutMembership: [], memberWithoutActivity: [] };
  const within = (date) => date !== null && monthsBetween(asOf, date) < settings.inactiveAfterMonths;
  const ctx = { settings, asOf, family, labels, out, within, byEntity: activityByEntity(activity), membersByEntity: groupBy(members, 'orgEntityId') };
  for (const e of entities) entityFindings(ctx, e);
  out.inactive.sort((a, b) => String(a.lastActivityOn ?? '').localeCompare(String(b.lastActivityOn ?? '')) || byLabel(a, b));
  out.markedInactiveButActive.sort(byLabel);
  out.activeWithoutMembership.sort((a, b) => byLabel(a, b) || b.total - a.total);
  out.memberWithoutActivity.sort(byLabel);
  return { asOf, findings: out };
}
