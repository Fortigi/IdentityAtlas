// Layout decisions for the matrix grouping headers — the rows that sit above the
// subject names and show which sort-attribute value each column belongs to.
//
// Two styles exist:
//   'rotated' — one 120 px row per sort level, values written vertically inside
//               merged cells (the original layout).
//   'cross'   — a cross table: one thin 20 px row per distinct value of a level,
//               with a mark in every subject column that carries that value.
//
// Which style wins is a property of the matrix DEFINITION (its subjects and its
// sort attributes) — never of the interaction state. Folding a group must not
// re-style the header underneath the click, so the mode is computed once from
// the unfolded subject set across ALL configured sort levels: the tallest the
// cross table could ever become. Because folding and member-explosion can only
// ever draw a SUBSET of those values, a cross table that fits in that worst case
// stays no taller than the rotated stack in every reachable state.
//
// All helpers here are pure and operate on the precomputed `sortKeys` array each
// subject carries (see sortUsers.js).

import { computeAttributeSpans } from './sortUsers';

// Height (px) of a rotated grouping row and of one cross-table value row. Both
// drive the cell height AND the sticky `top` offset of the <thead>, so the two
// can never drift apart.
export const GROUP_ROW_H = 120;
export const VALUE_ROW_H = 20;

// Distinct values at one sort level over the given subjects.
export function distinctValueCount(users, level) {
  const seen = new Set();
  for (const u of (users || [])) seen.add(u && u.sortKeys ? (u.sortKeys[level] ?? '') : '');
  return seen.size;
}

// 'cross' when the cross table is no taller than the rotated stack it replaces,
// otherwise 'rotated'. `levels` is the number of configured sort attributes (or
// org levels) — NOT the currently unfolded depth, which changes as the user
// interacts.
export function computeHeaderMode(users, levels) {
  const n = Math.max(0, Number(levels) || 0);
  if (n === 0) return 'cross';
  let crossH = 0;
  for (let level = 0; level < n; level++) crossH += distinctValueCount(users, level) * VALUE_ROW_H;
  return crossH <= n * GROUP_ROW_H ? 'cross' : 'rotated';
}

// What the column a span starts on is, at this level.
//
// A folded aggregate column at-or-below its own fold level is an aggregate (and
// below it, it shows its child-group count); at ANCESTOR levels the span is just
// a normal merged group whose value is the ancestor's. A member-exploded column
// collapses its members back at its own level and is inert below it.
export function classifySpanColumn(col, level) {
  const agg = !!col?.isAggregateCol;
  const mem = !!col?.isMemberCol;
  const foldLevel = agg ? col.level : -1;
  const memberLevel = mem ? col.memberLevel : -1;
  return {
    aggHere: agg && level >= foldLevel,
    showChildCount: agg && level > foldLevel,     // "6 departments"
    memberOwn: mem && level === memberLevel,
    memberDeep: mem && level > memberLevel,
  };
}

function spanClick(col, level, flags, handlers) {
  const { onToggleCollapse, onToggleMembers } = handlers;
  if (flags.memberOwn && onToggleMembers) return () => onToggleMembers(col.sortKeys, col.memberLevel);
  if (flags.collapsible) return () => onToggleCollapse(col.sortKeys, level);
  if (flags.aggHere && onToggleCollapse) return () => onToggleCollapse(col.sortKeys, col.level);
  return undefined;
}

function spanTitle(col, label, flags) {
  if (flags.memberOwn) return `Collapse ${label} members back into a count`;
  if (flags.collapsible) return `Collapse ${label} into one column`;
  if (flags.aggHere) return `Expand ${col.value || '(none)'} back into its columns`;
  return undefined;
}

// What a merged span at `level` means and does — the click it carries and the
// accessible name that describes it. Shared by both header styles so their
// interaction semantics can never drift apart.
export function spanInteraction(users, span, level, handlers = {}) {
  const col = users[span.start];
  const flags = classifySpanColumn(col, level);
  flags.collapsible = !!handlers.onToggleCollapse && !flags.aggHere && !flags.memberOwn && !flags.memberDeep;
  return {
    col,
    ...flags,
    onClick: spanClick(col, level, flags, handlers),
    title: spanTitle(col, span.value || '(none)', flags),
  };
}

// The cross-table shape of one sort level: the merged spans (each tagged with
// what it renders as) plus the value rows they fall into.
//
//   kind 'value'     — carries a real value at this level; joins that value's row
//   kind 'aggregate' — a folded column below its fold level; renders one block
//                      cell (the child-group count) spanning the level's rows
//   kind 'inert'     — a member-exploded column below its own level; no value
//
// Value rows keep first-appearance order, which — because the columns are
// already sorted and empty values sort last — puts `(none)` at the bottom.
export function buildCrossRows(users, level) {
  const spans = computeAttributeSpans(users, level).map(span => {
    const col = users[span.start];
    let kind = 'value';
    if (col?.isAggregateCol && level > col.level) kind = 'aggregate';
    else if (col?.isMemberCol && level > col.memberLevel) kind = 'inert';
    return { ...span, kind };
  });
  const rows = [];
  const seen = new Set();
  for (const span of spans) {
    if (span.kind !== 'value' || seen.has(span.value)) continue;
    seen.add(span.value);
    rows.push({ value: span.value });
  }
  // A level whose columns are ALL folded aggregates still has something to show
  // (their child-group counts), so keep one unlabelled row to carry them.
  if (rows.length === 0 && spans.some(s => s.kind === 'aggregate')) rows.push({ value: null });
  return { spans, rows };
}

// Left border of one access-package colour band: the first band opens the AP
// block, every later band opens a new category. Shared by the grouping rows and
// the names row so the two blocks line up.
export function apBandBorderClass(accessPackages, idx) {
  if (idx === 0) return 'border-l-2 border-l-indigo-300 dark:border-l-indigo-500';
  const prevCat = accessPackages[idx - 1].categoryName || null;
  const curCat = accessPackages[idx].categoryName || null;
  return prevCat !== curCat ? 'border-l-2 border-l-gray-400 dark:border-l-gray-500' : '';
}

// Combined height of the cross-table rows of every shown level — the sticky
// offset the <thead> must use so the names row comes to rest at top:0.
export function crossGroupingHeight(levels) {
  return (levels || []).reduce((h, lvl) => h + lvl.rows.length * VALUE_ROW_H, 0);
}
