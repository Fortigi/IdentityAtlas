// Pure helpers for the activity views: the Activity section of a collection
// entity (GET /api/org-truth/activity/subject/OrgEntity/:id) and the compact
// activity summary on a user / identity page (GET /activity/actor/:type/:id).
//
//   subject: { type, unit, total, firstOn, lastOn, months: [{ month: 'YYYY-MM', total }],
//              actors: [{ targetType, targetId, label, total, lastOn, isMember, memberRoles }],
//              unresolvedRows }
//   actor:   { groups: [{ type, unit, subjects: [{ targetType, targetId, label, total, lastOn, isMember }] }] }
//
// Dates are 'YYYY-MM-DD' (an activity's period start); shown per month. Kept
// apart from the .jsx so it is mutated (stryker.orgtruth.config.json).
import { formatHours, formatPeriod } from './evidence';
import { candidateDetailKind } from './reviewGroups';

// '2026-03-01' → 'March 2026'; '' for nothing.
export function formatOn(date) {
  if (!date) return '';
  return formatPeriod(String(date).slice(0, 7));
}

// A measure with its unit: '1,152.5 h'; just the number without a unit.
export function formatMeasure(total, unit) {
  const n = formatHours(total);
  return unit ? `${n} ${unit}` : n;
}

// The detail tab a referenced object opens (another list's entity included).
export function refDetailKind(targetType) {
  return candidateDetailKind(targetType);
}

// Bars of the per-month chart: height in px relative to the largest month
// (the largest is `maxHeight`, an empty month 0), in month order.
export function monthBars(months, maxHeight = 80) {
  const rows = [...(months ?? [])].sort((a, b) => String(a.month).localeCompare(String(b.month)));
  const max = Math.max(0, ...rows.map(m => Number(m.total) || 0));
  return rows.map(m => {
    const total = Number(m.total) || 0;
    return { month: m.month, total, height: max > 0 ? Math.round((total / max) * maxHeight) : 0, label: formatPeriod(m.month) };
  });
}

// Short axis label of a bar: 'Mar 26'.
export function shortMonth(month) {
  const long = formatPeriod(month);
  const m = /^(\w{3})\w* (\d{4})$/.exec(long);
  return m ? `${m[1]} ${m[2].slice(2)}` : long;
}

// Most activity first, then by name.
export function byTotalDesc(a, b) {
  return ((Number(b.total) || 0) - (Number(a.total) || 0)) || String(a.label ?? '').localeCompare(String(b.label ?? ''));
}

// The Member cell: 'yes · eigenaar, team', 'yes' or 'no'.
export function memberText(row) {
  if (!row?.isMember) return 'no';
  const roles = (row.memberRoles ?? []).filter(Boolean);
  return roles.length > 0 ? `yes · ${roles.join(', ')}` : 'yes';
}

// One line over the chart.
export function subjectLine(activity) {
  if (!activity) return '';
  const parts = [`${activity.type}: ${formatMeasure(activity.total, activity.unit)}`];
  if (activity.firstOn && activity.lastOn) parts.push(`from ${formatOn(activity.firstOn)} to ${formatOn(activity.lastOn)}`);
  const unresolved = Number(activity.unresolvedRows) || 0;
  if (unresolved > 0) parts.push(`${unresolved} ${unresolved === 1 ? 'row whose person is' : 'rows whose person is'} not resolved yet`);
  return parts.join(' · ');
}

// Nothing to show: no activity record refers to the subject.
export function subjectEmpty(activity) {
  return !activity || ((activity.months ?? []).length === 0 && (activity.actors ?? []).length === 0);
}

// The actor summary's groups that have subjects, subjects most active first.
export function actorGroups(data) {
  return (data?.groups ?? [])
    .filter(g => (g.subjects ?? []).length > 0)
    .map(g => ({ ...g, subjects: [...g.subjects].sort(byTotalDesc) }));
}
