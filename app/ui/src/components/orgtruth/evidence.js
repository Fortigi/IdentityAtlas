// Pure helpers for the "Evidence from other lists" section of the org-entity
// detail page (OrgEvidenceSection.jsx). GET /api/org-truth/entities/:id/evidence:
//
//   { entity: { id, entityType, displayName },
//     people: [{ via, principals: [{ principalId, label, worked, rows, hours, lastPeriod }] }],
//     activity: null | { referrerTypes, rows, hours, firstPeriod, lastPeriod, periods, unlinkedRows },
//     workedNotListed: [{ principalId, label, rows, hours, lastPeriod }] }
//
// Periods are 'YYYY-MM' strings. Kept apart from the .jsx so the verdict is
// mutated (stryker.orgtruth.config.json).
import { pillColorClass } from './orgFormat';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

const PERIOD_RE = /^(\d{4})-(\d{2})$/;

// Month index (year * 12 + month0) of a 'YYYY-MM' period, or null.
function periodIndex(period) {
  const m = PERIOD_RE.exec(String(period ?? ''));
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return Number(m[1]) * 12 + (month - 1);
}

// '2024-03' → 'March 2024'; anything else comes back as given ('' for null).
export function formatPeriod(period) {
  const idx = periodIndex(period);
  if (idx === null) return period == null ? '' : String(period);
  return `${MONTHS[idx % 12]} ${Math.floor(idx / 12)}`;
}

// Whole months from `period` to the month of `today` (0 = same month).
export function monthsSince(period, today = new Date()) {
  const idx = periodIndex(period);
  if (idx === null) return null;
  return today.getFullYear() * 12 + today.getMonth() - idx;
}

export const ACTIVE_MONTHS = 3;
export const QUIET_MONTHS = 12;

// Is the entity still worked on? `none` when no other list refers to it,
// `active` when the last hours are at most 3 months old, `quiet` up to 12
// months, `inactive` beyond that (or when no row carries a period).
export function activityVerdict(activity, today = new Date()) {
  if (!activity) return { kind: 'none', text: 'No other list refers to this entity' };
  const age = monthsSince(activity.lastPeriod, today);
  if (age === null) return { kind: 'inactive', text: 'No dated hours found' };
  const last = formatPeriod(activity.lastPeriod);
  if (age <= ACTIVE_MONTHS) return { kind: 'active', text: `Hours written until ${last}` };
  if (age <= QUIET_MONTHS) return { kind: 'quiet', text: `Quiet: last hours in ${last}` };
  return { kind: 'inactive', text: `No hours since ${last}` };
}

const VERDICT_COLOR = { active: 'green', quiet: 'amber' };

// Soft pill fill of a verdict: active green, quiet amber, inactive and none gray.
export function verdictPillClass(kind) {
  return pillColorClass(VERDICT_COLOR[kind] || 'gray');
}

// Distinct people across the `people` groups, and how many of them worked on it.
export function summarizePeople(people) {
  const worked = new Map();
  for (const group of people || []) {
    for (const p of group?.principals || []) {
      worked.set(p.principalId, Boolean(worked.get(p.principalId) || p.worked));
    }
  }
  const workedCount = [...worked.values()].filter(Boolean).length;
  return { listed: worked.size, worked: workedCount, notWorked: worked.size - workedCount };
}

// Hours rounded to one decimal, thousands separated ('1,234.5').
export function formatHours(hours) {
  const n = Number(hours);
  if (!Number.isFinite(n)) return '0';
  return (Math.round(n * 10) / 10).toLocaleString('en-US');
}

// The "Worked on it" cell, in words.
export function workedText(principal) {
  if (!principal?.worked) return 'no hours found';
  return principal.lastPeriod ? `yes, until ${formatPeriod(principal.lastPeriod)}` : 'yes';
}

// One line about the hours other lists record against the entity.
export function activityLine(activity) {
  if (!activity) return '';
  const rows = Number(activity.rows) || 0;
  const parts = [`${rows.toLocaleString('en-US')} ${rows === 1 ? 'row' : 'rows'}`, `${formatHours(activity.hours)} hours`];
  if (activity.firstPeriod && activity.lastPeriod) {
    parts.push(`from ${formatPeriod(activity.firstPeriod)} to ${formatPeriod(activity.lastPeriod)}`);
  }
  const unlinked = Number(activity.unlinkedRows) || 0;
  if (unlinked > 0) parts.push(`${unlinked} ${unlinked === 1 ? 'row whose person is' : 'rows whose person is'} not linked to an account`);
  return parts.join(' · ');
}

// The section has nothing to say: nobody linked and no other list refers to it.
export function evidenceEmpty(evidence) {
  return !evidence || ((evidence.people || []).length === 0 && !evidence.activity);
}
