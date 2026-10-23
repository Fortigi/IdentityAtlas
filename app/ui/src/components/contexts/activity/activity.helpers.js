// Pure helpers for "Upload activity" and the Activity section of a context page.
// No React, so every branch is unit-tested directly. The mapping and the
// responses are the API's (app/api/src/contexts/activity/; docs/architecture/context-activity.md).

export const ACTIVITY_STEPS = { file: 1, mapping: 2, preview: 3 };
export const ACTIVITY_STEP_LIST = [
  { n: ACTIVITY_STEPS.file, label: 'File' },
  { n: ACTIVITY_STEPS.mapping, label: 'Mapping' },
  { n: ACTIVITY_STEPS.preview, label: 'Preview' },
];

// The single-column roles, in the order the form shows them. The sub-unit
// column is offered only on a context with sub-units.
const SUB_UNIT_FIELD = { field: 'contextColumn', label: 'Sub-unit', help: 'The column naming the unit below this one each row is about (a client, a project). Matched by key, then by name.' };
const PERSON_FIELDS = [
  { field: 'subjectNameColumn', label: 'Person (name)', help: 'Who did it. A name or a user name.' },
  { field: 'subjectEmailColumn', label: 'Person (e-mail)', help: 'Matched before the name when both are given.' },
  { field: 'dateColumn', label: 'Date', help: 'The day of the activity.', required: true },
  { field: 'amountColumn', label: 'Amount', help: 'Hours or a count. Empty = every row is one event.' },
  { field: 'kindColumn', label: 'Kind', help: 'What kind of activity: a task, an operation.' },
];

export function activityRoleFields(hasChildren) {
  return hasChildren ? [SUB_UNIT_FIELD, ...PERSON_FIELDS] : PERSON_FIELDS;
}

export const UNIT_OPTIONS = [{ value: 'hours', label: 'Hours' }, { value: 'events', label: 'Events (a count)' }];
export const DATE_ORDER_OPTIONS = [{ value: 'dmy', label: 'Day first (18-04-2026)' }, { value: 'mdy', label: 'Month first (04/18/2026)' }];

const ROLE_KEYS = [SUB_UNIT_FIELD, ...PERSON_FIELDS].map(f => f.field);

/** Every column a role of the mapping takes. */
export function usedActivityColumns(mapping) {
  return new Set(ROLE_KEYS.map(k => mapping[k]).filter(Boolean));
}

/**
 * Set one role column ('' clears it). A column taken by a role stops being an
 * attribute; clearing the amount makes every row one event, choosing one makes
 * it hours again.
 */
export function withActivityRole(mapping, field, column) {
  const value = column || null;
  const next = {
    ...mapping,
    [field]: value,
    attributeColumns: value ? mapping.attributeColumns.filter(c => c !== value) : mapping.attributeColumns,
  };
  if (field === 'amountColumn') next.unit = value ? (mapping.amountColumn ? mapping.unit : 'hours') : 'events';
  return next;
}

/** What stops a preview, in the analyst's words. Empty when the mapping can be previewed. */
export function activityProblems(mapping) {
  const problems = [];
  if (!mapping.sourceLabel?.trim()) problems.push('Name the source of this export.');
  if (!mapping.dateColumn) problems.push('Choose the column that holds the date.');
  if (!mapping.subjectNameColumn && !mapping.subjectEmailColumn) problems.push('Choose a column that names the person.');
  const roles = ROLE_KEYS.map(k => mapping[k]).filter(Boolean);
  if (new Set(roles).size < roles.length) problems.push('A column can play one role only.');
  return problems;
}

/** The footer of one wizard step: the primary button's label, whether it is blocked, and whether Back is offered. */
export function activityStepFooter(step, { file, problems, preview }) {
  if (step === ACTIVITY_STEPS.file) return { label: 'Read the file ▸', blocked: !file, showBack: false };
  if (step === ACTIVITY_STEPS.mapping) return { label: 'Preview ▸', blocked: problems.length > 0, showBack: true };
  return { label: 'Import', blocked: !preview || preview.rowsToImport === 0, showBack: true };
}

const round1 = (n) => Math.round(n * 10) / 10;

/** "12.5 h", "1 event", "3 events"; "—" for nothing. */
export function formatAmount(amount, unit) {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return '—';
  if (unit === 'hours') return `${round1(amount)} h`;
  return `${round1(amount)} ${amount === 1 ? 'event' : 'events'}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-04' → 'Apr 2026'; `short` → 'Apr'. */
export function monthLabel(month, { short = false } = {}) {
  const [y, m] = String(month).split('-');
  const name = MONTHS[Number(m) - 1] ?? month;
  return short ? name : `${name} ${y}`;
}

/** The bar heights (0..1) of a perMonth list, relative to its largest month. */
export function barHeights(perMonth) {
  const max = Math.max(0, ...perMonth.map(p => p.amount));
  return perMonth.map(p => (max > 0 ? p.amount / max : 0));
}

// The four groups (and the two of a context without people members), in the order shown.
export const GROUPS = {
  memberAndActive: { label: 'Member and active', help: 'Members of this unit with activity in the period.' },
  activeNotMember: { label: 'Active, not a member', help: 'Known people with activity here who are not members — a suggestion for the member review.', suggestion: true },
  memberNoActivity: { label: 'Member, no activity in period', help: 'Members without activity in the period — a suggestion for the member review.', suggestion: true },
  activeUnknown: { label: 'Active, unknown person', help: 'Names in the export that matched no account or person.' },
  active: { label: 'Active people', help: 'Known people with activity here.' },
};

export const groupInfo = (key) => GROUPS[key] ?? { label: key, help: '' };

/** The detail page a person of a group opens: their identity, else their account; null when unknown. */
export function personLink(person) {
  if (person.identityId) return { kind: 'identity', id: person.identityId };
  if (person.principalId) return { kind: 'user', id: person.principalId };
  if (person.memberId) return { kind: person.memberType === 'Identity' ? 'identity' : 'user', id: person.memberId };
  return null;
}

const pad = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

// The periods the selector offers, counted back from the latest activity:
// months: N calendar months ending in the latest date's month.
export const PERIOD_OPTIONS = [
  { value: '3', label: 'Last 3 months', months: 3 },
  { value: '6', label: 'Last 6 months', months: 6 },
  { value: '12', label: 'Last 12 months', months: 12 },
  { value: '24', label: 'Last 24 months', months: 24 },
];

/** { from, to } for a period option, ending at `latest` (YYYY-MM-DD); null for the default (12 months) without a latest. */
export function periodFor(value, latest) {
  const option = PERIOD_OPTIONS.find(o => o.value === value);
  if (!option || !latest) return null;
  const [y, m] = latest.split('-').map(Number);
  return { from: isoDay(new Date(Date.UTC(y, m - option.months, 1))), to: latest };
}

/** The query string of a period, '' for the default. */
export const periodQuery = (period) => (period ? `?from=${period.from}&to=${period.to}` : '');

/** One line on an upload of the history. */
export function uploadLine(u) {
  const period = u.periodStart ? `${u.periodStart} – ${u.periodEnd}` : 'no dates';
  const held = u.rowsHeld === 0 ? 'replaced by a later upload' : `${u.rowsHeld} rows`;
  return `${u.sourceLabel} · ${u.fileName} · ${period} · ${held}`;
}

/** The preview's import line: "120 rows to import on 4 units · 3 not placed · 2 by unknown people". */
export function importLine(preview) {
  const parts = [`${preview.rowsToImport} rows to import${preview.subUnitsReached > 1 ? ` on ${preview.subUnitsReached} units` : ''}`];
  if (preview.rowsNotPlaced) parts.push(`${preview.rowsNotPlaced} not placed`);
  if (preview.rowsUnknownPerson) parts.push(`${preview.rowsUnknownPerson} by people not found`);
  return parts.join(' · ');
}

/** The skipped rows as one line: "2 without a date · 1 without an amount". Empty when none. */
export function skippedLine(skipped) {
  const words = { 'no date': 'without a date', 'no amount': 'without an amount', 'no person': 'without a person' };
  return Object.entries(skipped || {}).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${words[k] ?? k}`).join(' · ');
}

/**
 * What the Activity section shows, from its three reads: the periods of the
 * context's own activity and of its sub-units', whether there is anything at
 * all, whether the groups have anyone, and the latest date a chosen period
 * counts back from (`chosenLatest`, once known, stays).
 */
const periodOf = (read) => read?.period ?? null;
const hasAnyone = (own) => (own?.groups || []).some(g => g.people.length > 0);
const lastEnd = (periods) => periods.filter(Boolean).map(p => p.to).sort().at(-1) ?? null;

export function sectionShape({ own, summary, uploads = [], chosenLatest = null }) {
  const ownPeriod = periodOf(own);
  const childPeriod = periodOf(summary);
  return {
    ownPeriod,
    childPeriod,
    empty: !ownPeriod && !childPeriod && uploads.length === 0,
    hasPeople: !!ownPeriod && hasAnyone(own),
    latest: chosenLatest ?? lastEnd([ownPeriod, childPeriod]),
    shown: ownPeriod ?? childPeriod,
  };
}
