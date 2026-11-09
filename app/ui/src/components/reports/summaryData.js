// The numbers behind a report's on-screen summary: the charts and pivots a
// template declares (the same declarations the xlsx download builds its Charts
// tab and pivot tables from), computed from the rows the page already holds.
//
// Groups come in the order their first row does, not alphabetically: reports
// sort worst first, so the summary reads worst first too — the same order the
// workbook's pie legend uses.

import { TAG_COLORS } from '@ui/utils/colors';

export const BLANK_LABEL = '(blank)';

/** A slice's colour: the template's, when it gave a valid six-digit hex, else the shared palette. */
export function sliceColor(chart, label, index) {
  const declared = chart.colors?.[label];
  return /^[0-9A-Fa-f]{6}$/.test(declared || '') ? `#${declared}` : TAG_COLORS[index % TAG_COLORS.length];
}

/** What the workbook adds for a report, in words: "pivot tables and charts". */
export function xlsxKinds(pivots, charts) {
  return [pivots.length && 'pivot tables', charts.length && 'charts'].filter(Boolean).join(' and ');
}

/** How a cell value reads as a group: blanks fold into one "(blank)" group. */
export function groupLabel(value) {
  return value === null || value === undefined || value === '' ? BLANK_LABEL : String(value);
}

/** A number to add up; anything that is not a finite number adds nothing. */
function addend(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return value !== null && value !== '' && Number.isFinite(n) ? n : 0;
}

/**
 * One chart's slices: each category with how many rows hold it, or — when the
 * chart names a `value` column — the sum of that column over those rows.
 */
export function chartSeries(chart, rows) {
  const totals = new Map();
  for (const row of rows) {
    const label = groupLabel(row?.[chart.category]);
    totals.set(label, (totals.get(label) || 0) + (chart.value ? addend(row[chart.value]) : 1));
  }
  const total = [...totals.values()].reduce((s, v) => s + v, 0);
  return [...totals].map(([label, value]) => ({ label, value, share: total > 0 ? value / total : 0 }));
}

const newGroup = (label, values) => ({
  label, count: 0, totals: Object.fromEntries(values.map(k => [k, 0])), rows: [],
});

/**
 * A pivot's groups, nested one level per `rows` key: each group's label, how
 * many rows it holds, the sum of every `values` column, and its sub-groups.
 * Filters are a workbook control and are not applied here.
 */
export function pivotGroups(pivot, rows, depth = 0) {
  const keys = pivot.rows || [];
  const values = pivot.values || [];
  const key = keys[depth];
  if (!key) return [];
  const groups = new Map();
  for (const row of rows) {
    const label = groupLabel(row?.[key]);
    const group = groups.get(label) || newGroup(label, values);
    group.count += 1;
    for (const v of values) group.totals[v] += addend(row[v]);
    group.rows.push(row);
    groups.set(label, group);
  }
  return [...groups.values()].map(({ rows: held, ...group }) => ({
    ...group,
    key,
    children: pivotGroups(pivot, held, depth + 1),
  }));
}

/** Whether a row matches every `{ key, label }` condition of a filter. */
export function matchesFilter(row, filter) {
  return filter.every(({ key, label }) => groupLabel(row?.[key]) === label);
}
