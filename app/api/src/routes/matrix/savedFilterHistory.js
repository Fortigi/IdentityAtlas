// "Who changed this matrix, and to what" — the trail behind a saved matrix.
//
// Saved matrices are org-wide documents: anybody who can reach the Matrix tab
// can rename one, re-cut it or point it at different contexts, and the row only
// remembers the LAST writer. When a matrix that used to produce rows stops
// producing them, the useful question is who moved it and when — so migration
// 069 attaches the generic `_history` snapshot trigger to SavedMatrixFilters
// and the functions here turn those snapshots into readable events.
//
// Everything in this file is pure: the route hands it raw `_history` rows and
// renders what comes back. A snapshot carries the whole row, so the actor of a
// change is the `updatedBy` INSIDE that snapshot — there is no separate actor
// column to keep in step.

// Bookkeeping columns. `updatedBy`/`updatedAt` are how the event knows its
// actor and its time, so reporting them again as changed fields would print
// "Updated By: anna → wim" next to "wim, 3 days ago".
export const HISTORY_SKIP_FIELDS = new Set([
  'id', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy',
]);

// The scalar columns, in the order an event lists them.
const SCALAR_FIELDS = [
  ['name', 'Name'],
  ['description', 'Description'],
  ['isDefault', 'Org default'],
];

// Which PART of the matrix a filter key belongs to. The label is what the
// reader sees ("subjects, roll-up"), so keys that mean the same thing to an
// analyst deliberately share one.
const FILTER_PART_BY_KEY = new Map([
  ['rowType', 'subjects'],
  ['subject', 'subjects'],
  ['resource', 'resources'],
  ['managed', 'governed lens'],
  ['includeBusinessRoles', 'content'],
  ['includeInheritedAccess', 'content'],
  ['orientation', 'layout'],
  ['rollup', 'roll-up'],
  ['rollupContent', 'roll-up'],
  ['rollupMetric', 'roll-up'],
  ['rollupKind', 'roll-up'],
  ['rollupContextId', 'roll-up'],
  ['rollupPath', 'roll-up'],
  // Where the analyst had drilled to / folded when they saved — part of the
  // stored filter, but not part of what the matrix compares. Named separately
  // so "view state" never reads as a change to the matrix itself.
  ['rollupExpanded', 'view state'],
  ['rollupCollapsed', 'view state'],
  ['foldAttributes', 'view state'],
  ['foldOnLoad', 'view state'],
  ['sortAttributes', 'view state'],
  ['sortHierarchy', 'view state'],
  ['showTrends', 'view state'],
]);

// The order parts are listed in, so two events that changed the same things
// read identically.
const PART_ORDER = ['subjects', 'resources', 'content', 'governed lens', 'roll-up', 'layout', 'view state', 'other settings'];

// Server-side mirror of the timeline's formatter, so a matrix change reads like
// every other history row in the app.
export function formatHistoryValue(val) {
  if (val === null || val === undefined) return '—';
  if (val === true) return 'Yes';
  if (val === false) return 'No';
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Which parts of the matrix a filter change touched, e.g. ['subjects','roll-up'].
// A key nobody has classified still counts — as 'other settings' — so a filter
// key added later shows up as a change rather than vanishing from the trail.
export function filterChangeParts(prev, next) {
  const before = prev && typeof prev === 'object' ? prev : {};
  const after = next && typeof next === 'object' ? next : {};
  const parts = new Set();
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (sameJson(before[key], after[key])) continue;
    parts.add(FILTER_PART_BY_KEY.get(key) || 'other settings');
  }
  return PART_ORDER.filter(p => parts.has(p));
}

// The changed fields between two row snapshots, as display-ready entries.
// The filter is reported by the parts it touched rather than as two blobs of
// JSON — nobody can read a diff of the whole matrix definition.
export function savedMatrixChanges(prevData, rowData) {
  const before = prevData || {};
  const after = rowData || {};
  const changes = [];

  for (const [field, label] of SCALAR_FIELDS) {
    const from = formatHistoryValue(before[field]);
    const to = formatHistoryValue(after[field]);
    if (from !== to) changes.push({ field, label, from, to });
  }

  const parts = filterChangeParts(before.filter, after.filter);
  if (parts.length > 0) changes.push({ field: 'filter', label: 'Matrix contents', parts });

  // Anything the two lists above don't name — a column added to the table
  // later — is still reported, so the trail can't quietly go silent on it.
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (HISTORY_SKIP_FIELDS.has(key) || key === 'filter') continue;
    if (SCALAR_FIELDS.some(([f]) => f === key)) continue;
    const from = formatHistoryValue(before[key]);
    const to = formatHistoryValue(after[key]);
    if (from !== to) changes.push({ field: key, label: key, from, to });
  }

  return changes;
}

// One `_history` row → the event it describes, or null when an update turned
// out to change nothing a reader cares about (a re-save that only re-stamped
// updatedAt/updatedBy).
export function savedMatrixHistoryEvent(row) {
  const rowData = row?.rowData || {};
  const at = row?.changedAt ?? null;
  if (row?.operation === 'I') {
    return { at, actor: rowData.createdBy || rowData.updatedBy || null, operation: 'created', changes: [] };
  }
  if (row?.operation === 'D') {
    // Nothing records WHO deleted a row — the snapshot is the row as it last
    // stood. Claiming its last editor did it would be a guess.
    return { at, actor: null, operation: 'deleted', changes: [] };
  }
  const changes = savedMatrixChanges(row?.prevData, rowData);
  if (changes.length === 0) return null;
  return { at, actor: rowData.updatedBy || null, operation: 'changed', changes };
}

// The trail for one saved matrix, newest first — the shape the History dialog
// renders. Rows arrive newest-first from the query and that order is kept.
export function savedMatrixHistory(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map(savedMatrixHistoryEvent).filter(Boolean);
}
