// The rules behind the Matrix wizard's "Sort" step, kept out of the component
// that renders them (#1202).
//
// MatrixSortStep.jsx was extracted from MatrixFilterWizard.jsx, which carried
// these rules inline and never had them asserted on their own. They decide what
// the analyst may sort by and how the matrix OPENS, so they are worth killing
// mutants over — a JSX file is not: mutating one measures Tailwind classes.
// Everything here is pure, so it is mutation-tested (see stryker.pilot.config)
// while the component stays chrome.

import { DEFAULT_SORT } from '@ui/utils/matrixFilter';
import { FOLD_AUTO_THRESHOLD } from './MatrixFilterWizard.helpers';

// A matrix sorted on more levels than this is unreadable, and each level costs a
// grouped header row.
export const MAX_SORT_ROWS = 6;

// Selectable attribute names from a /matrix/columns response. Anything without a
// `column` is not addressable, and displayName is excluded deliberately: every
// value is unique, so grouping or sorting by it says nothing.
export function attributeOptions(columns) {
  if (!Array.isArray(columns)) return [];
  return columns
    .map(c => c.column)
    .filter(Boolean)
    .filter(name => name !== 'displayName');
}

// The levels being edited. An empty saved sort means "never chosen", which shows
// as the default rather than as no sort at all.
export function sortRows(sortAttributes) {
  return Array.isArray(sortAttributes) && sortAttributes.length ? sortAttributes : DEFAULT_SORT;
}

// What 'auto' resolves to: big matrices open folded so the first render stays fast.
export function autoFolds(assignmentCount) {
  return (assignmentCount || 0) >= FOLD_AUTO_THRESHOLD;
}

// fold-on-load is tri-state — 'auto' defers to the assignment count, anything
// else is the analyst's explicit yes/no and the count is irrelevant.
export function foldOnLoadChecked(foldOnLoad, assignmentCount) {
  return foldOnLoad === 'auto' ? autoFolds(assignmentCount) : !!foldOnLoad;
}

// Offer another level only while one is left to add — an attribute already used
// would sort on a value that cannot vary within its own group.
export function canAddSortRow(rows, options) {
  return rows.length < MAX_SORT_ROWS && options.length > rows.length;
}

// Add the first attribute not already sorted on. Falls back to the first option
// when every one is taken, and changes nothing when there are no options at all.
export function addSortRow(rows, options) {
  const used = new Set(rows.map(r => r.attribute));
  const next = options.find(o => !used.has(o)) || options[0];
  return next ? [...rows, { attribute: next, dir: 'asc' }] : rows;
}

export function updateSortRow(rows, index, patch) {
  return rows.map((r, i) => i === index ? { ...r, ...patch } : r);
}

export function removeSortRow(rows, index) {
  return rows.filter((_, i) => i !== index);
}

// Flipping one level's direction, without the component knowing which two values
// "direction" has.
export function toggleDir(dir) {
  return dir === 'asc' ? 'desc' : 'asc';
}
