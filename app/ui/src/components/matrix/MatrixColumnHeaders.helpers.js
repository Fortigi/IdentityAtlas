// Pure helpers for the matrix column-header rows. Extracted from
// MatrixColumnHeaders so the derivation logic (which grouping cells are
// collapsible aggregates, member explosions or plain merged groups, plus the
// access-package band styling and subject tooltips) stays small and unit-testable.

// Height (px) of each attribute grouping row. Drives both the cell height and
// the sticky `top` offset of the <thead>, so the two can never drift apart.
export const GROUP_ROW_H = 120;

// Height (px) of the accounts row that appears under the names row while at
// least one identity is expanded. It sits AFTER the names row, so it must never
// feed the <thead>'s sticky offset — only the grouping rows above the names row
// do, or the pinned header escapes upward and leaves a grey band on scroll.
export const ACCOUNT_ROW_H = 72;

// Split the rendered subject columns into the names row and the accounts row
// beneath it. An expanded identity keeps its own roll-up column and spans it
// plus each of its account sub-columns, which move down a row.
//
// An account column whose parent identity is not among the columns stays in the
// names row: the two rows must always add up to the same grid width as the body,
// and an orphan account still owns a real body column.
export function splitAccountColumns(users) {
  const cols = Array.isArray(users) ? users : [];
  const ids = new Set(cols.map(c => c.id));
  const accountsByParent = new Map();
  const namesCols = [];
  for (const col of cols) {
    const parentId = col.isAccountCol ? col.parentId : null;
    if (parentId && ids.has(parentId)) {
      if (!accountsByParent.has(parentId)) accountsByParent.set(parentId, []);
      accountsByParent.get(parentId).push(col);
    } else {
      namesCols.push(col);
    }
  }
  return { namesCols, accountsByParent, hasAccountsRow: accountsByParent.size > 0 };
}

// Tooltip for the roll-up cell that keeps an expanded identity's own column on
// the accounts row.
export function accountRollupTitle(user) {
  return `All accounts — ${user.displayName}'s combined access across every linked account`;
}

const none = (v) => v || '(none)';

// Classify one grouping span from the aggregate/member state of its lead column.
// `aggHere`: the span IS a collapsed aggregate at-or-below its fold level. At
// ancestor rows (rowIdx < level) it is a normal merged group. A member-exploded
// org owns its header at rowIdx === memberLevel; deeper rows are inert.
export function spanState(col, rowIdx) {
  const isAgg = !!col?.isAggregateCol;
  const isMember = !!col?.isMemberCol;
  const aggHere = isAgg && rowIdx >= col.level;
  return {
    aggHere,
    showChildCount: aggHere && rowIdx > col.level,
    memberOwn: isMember && rowIdx === col.memberLevel,
    memberDeep: isMember && rowIdx > col.memberLevel,
  };
}

function spanClick(s, collapsible, col, rowIdx, onToggleCollapse, onToggleMembers) {
  if (s.memberOwn && onToggleMembers) return () => onToggleMembers(col.sortKeys, col.memberLevel);
  if (collapsible) return () => onToggleCollapse(col.sortKeys, rowIdx);
  if (s.aggHere) return () => onToggleCollapse(col.sortKeys, col.level);
  return undefined;
}

function spanTitle(s, collapsible, col, span) {
  if (s.memberOwn) return `Collapse ${none(span.value)} members back into a count`;
  if (collapsible) return `Collapse ${none(span.value)} into one column`;
  if (s.aggHere) return `Expand ${none(col.value)} back into its columns`;
  return undefined;
}

function spanLabel(s, col, span) {
  if (s.aggHere) return `▤ ${none(col.value)}`;
  if (s.memberOwn) return `▾ ${none(span.value)}`;
  return none(span.value);
}

// Everything one grouping <th> needs, derived from its column + row index.
export function computeGroupingCell({ col, rowIdx, span, onToggleCollapse, onToggleMembers }) {
  const s = spanState(col, rowIdx);
  const collapsible = !!onToggleCollapse && !s.aggHere && !s.memberOwn && !s.memberDeep;
  return {
    onClick: spanClick(s, collapsible, col, rowIdx, onToggleCollapse, onToggleMembers),
    title: spanTitle(s, collapsible, col, span),
    highlight: s.aggHere || s.memberOwn,
    showChildCount: s.showChildCount,
    childCount: col?.childCounts?.[rowIdx] ?? 0,
    label: spanLabel(s, col, span),
  };
}

// True when the access package at `idx` starts a new category band (or is first).
export function isApCategoryBoundary(accessPackages, idx) {
  if (idx === 0) return true;
  const prev = accessPackages[idx - 1].categoryName || null;
  const cur = accessPackages[idx].categoryName || null;
  return prev !== cur;
}

// Left-border classes for an access-package band cell — indigo on the very
// first band, grey at each category boundary, none inside a category.
export function apLeftBorderClass(idx, isCategoryBoundary) {
  if (idx === 0) return 'border-l-2 border-l-indigo-300 dark:border-l-indigo-500';
  if (isCategoryBoundary) return 'border-l-2 border-l-gray-400 dark:border-l-gray-500';
  return '';
}

// Multi-line tooltip for a subject (name) column.
export function subjectTitle(user) {
  const isAcct = !!user.isAccountCol;
  const acct = isAcct ? ` (account${user.accountType ? ' · ' + user.accountType : ''})` : '';
  return `${user.displayName}${acct}\n${user.jobTitle || ''}\n${user.department || ''}`;
}

// Rotated label text for a subject column (accounts append their type).
export function subjectLabel(user) {
  return user.isAccountCol && user.accountType
    ? `${user.displayName} · ${user.accountType}`
    : user.displayName;
}

// Glyph on an identity column's expand control.
export function identityGlyph(isLoadingCol, isExpanded) {
  if (isLoadingCol) return '⋯';
  return isExpanded ? '▾' : '▸';
}
