// Authorization workbench — the people as an Excel-like table. Pure.
//
// One row per person. The left of the grid is columns: the person's name, system
// data (job title, department, e-mail, …) and what is known of their work
// (activity, expertise, duty — multi-valued, with their evidence state). Every
// column can be filtered like Excel — tick the values to keep, "(Not known)" /
// "(Blanks)" included; a multi-value column keeps a row when ANY of its values is
// ticked; proposed-only knowledge can be left out — and sorted (a multi-value
// column by its strongest value). Filters on several columns combine with AND.

import { attributeLabel } from '@ui/utils/formatters';
import { SHOWN_STATES } from './workbench.model';

export const BLANK = '__blank';

const KNOWLEDGE = (key, label) => ({ key, label, type: 'knowledge', width: 170 });
const TEXT = (key, label, extra = {}) => ({ key, label: label ?? attributeLabel(key) ?? key, type: 'text', width: 130, ...extra });

// Every column the table can show, in the order it shows them.
export const PEOPLE_COLUMNS = Object.freeze([
  { key: 'displayName', label: 'Display name', type: 'name', width: 190, fixed: true },
  TEXT('jobTitle', 'Job title', { shown: true }),
  TEXT('department', 'Department'),
  TEXT('email', 'E-mail', { width: 180 }),
  TEXT('employeeId', 'Employee ID', { width: 100 }),
  TEXT('manager', 'Manager'),
  TEXT('companyName', 'Company'),
  TEXT('officeLocation', 'Office'),
  TEXT('city', 'City', { width: 100 }),
  TEXT('country', 'Country', { width: 100 }),
  { key: 'units', label: 'Unit', type: 'multi', width: 130 },
  { key: 'systems', label: 'Systems', type: 'multi', width: 130 },
  { key: 'accounts', label: 'Accounts', type: 'count', width: 80 },
  { ...KNOWLEDGE('activity', 'Activity'), shown: true },
  { ...KNOWLEDGE('expertise', 'Expertise'), shown: true },
  { ...KNOWLEDGE('duty', 'Duty'), shown: true },
]);

export const DEFAULT_COLUMNS = PEOPLE_COLUMNS.filter(c => c.fixed || c.shown).map(c => c.key);
export const columnByKey = new Map(PEOPLE_COLUMNS.map(c => [c.key, c]));

const STRENGTH = { confirmed: 3, disputed: 2, proposed: 1 };

/**
 * A person's values in one column, as [{ value, label, state? }] — empty when
 * there is none. Knowledge: every link not rejected (or only the not-proposed ones
 * when `includeProposed` is false), strongest evidence first. Pure.
 */
export function cellValues(person, column, includeProposed = true) {
  const key = column.key;
  if (column.type === 'knowledge') {
    return (person.knowledge || [])
      .filter(l => l.kind === key && SHOWN_STATES.has(l.state) && (includeProposed || l.state !== 'proposed'))
      .sort((a, b) => (STRENGTH[b.state] ?? 0) - (STRENGTH[a.state] ?? 0) || a.name.localeCompare(b.name))
      .map(l => ({ value: l.name.toLowerCase().replace(/\s+/g, ' ').trim(), label: l.name, state: l.state, link: l }));
  }
  if (column.type === 'count') return [{ value: String(person.accounts.length), label: String(person.accounts.length) }];
  if (column.type === 'multi') return (person[key] ?? person.attributes?.[key] ?? []).map(v => ({ value: v, label: v }));
  const v = person[key] ?? person.attributes?.[key];
  return v == null || v === '' ? [] : [{ value: String(v), label: String(v) }];
}

const blankLabel = (column) => (column.type === 'knowledge' ? '(Not known)' : '(Blanks)');

/** The distinct values of a column over these people, with how many people have each; blanks last. Pure. */
export function distinctValues(people, column, includeProposed = true) {
  const counts = new Map();
  let blanks = 0;
  for (const p of people) {
    const vals = cellValues(p, column, includeProposed);
    if (vals.length === 0) blanks++;
    for (const v of new Map(vals.map(x => [x.value, x])).values()) {
      const e = counts.get(v.value) ?? { value: v.value, label: v.label, count: 0 };
      e.count++;
      counts.set(v.value, e);
    }
  }
  const out = [...counts.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  if (blanks > 0) out.push({ value: BLANK, label: blankLabel(column), count: blanks });
  return out;
}

/**
 * Does this person pass one column's filter? ANY of their values ticked, or
 * containing one of the filter's `contains` texts (case aside) — or blank ticked
 * when they have none. Pure.
 */
export function matchesFilter(person, column, filter) {
  const vals = cellValues(person, column, filter.includeProposed !== false);
  if (vals.length === 0) return filter.values.has(BLANK);
  const contains = (filter.contains || []).map(t => t.toLowerCase());
  return vals.some(v => filter.values.has(v.value) || contains.some(t => v.label.toLowerCase().includes(t)));
}

/** The people passing every active filter (AND across columns). Pure. */
export function applyFilters(people, filters) {
  const active = Object.entries(filters).filter(([, f]) => f && f.values);
  if (active.length === 0) return people;
  return people.filter(p => active.every(([key, f]) => matchesFilter(p, columnByKey.get(key), f)));
}

/** People sorted by one column (a multi-value column by its strongest value), blanks last; then by name. Pure. */
export function sortPeople(people, sort) {
  const byName = (a, b) => a.displayName.localeCompare(b.displayName);
  if (!sort?.key) return [...people].sort(byName);
  const column = columnByKey.get(sort.key);
  const first = (p) => cellValues(p, column)[0]?.label ?? null;
  const dir = sort.dir === 'desc' ? -1 : 1;
  return [...people].sort((a, b) => {
    const x = first(a);
    const y = first(b);
    if (x === null || y === null) return (x === null) - (y === null) || byName(a, b);
    return dir * x.localeCompare(y, undefined, { numeric: true }) || byName(a, b);
  });
}

/** The active filters in words, for the strip: [{ key, text }]. Pure. */
export function filterSummary(filters, people) {
  return Object.entries(filters).filter(([, f]) => f && f.values).map(([key, f]) => {
    const column = columnByKey.get(key);
    const labels = distinctValues(people, column).filter(v => f.values.has(v.value)).map(v => v.label);
    const proposed = column.type === 'knowledge' && f.includeProposed === false ? ' (confirmed only)' : '';
    const parts = [...(f.contains || []).map(t => `contains “${t}”`), ...labels];
    return { key, text: `${column.label}: ${parts.length ? parts.join(', ') : 'nothing'}${proposed}` };
  });
}

/** The left offset of each shown column, for sticky positioning. Pure. */
export function stickyOffsets(columns) {
  const out = [];
  let left = 0;
  for (const c of columns) { out.push(left); left += c.width; }
  return { offsets: out, total: left };
}
