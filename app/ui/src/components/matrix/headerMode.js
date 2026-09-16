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
// subject carries (see sortUsers.js). What a span means and does at a level
// (aggregate / member-exploded / plain group) is shared with the rotated rows
// through MatrixColumnHeaders.helpers.js, so the two styles cannot drift apart.

import { computeAttributeSpans } from './sortUsers';
import { GROUP_ROW_H } from './MatrixColumnHeaders.helpers';

// Height (px) of one cross-table value row. Drives both the cell height AND the
// sticky `top` offset of the <thead>, so the two can never drift apart.
export const VALUE_ROW_H = 20;

// The first value row grows to this height when it carries the column-axis
// corner controls (24 px icon buttons), so they never overflow a 20 px row.
export const CORNER_ROW_H = 28;

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

// Combined height of the cross-table rows of every shown level — the sticky
// offset the <thead> must use so the names row comes to rest at top:0. With
// `withCorner`, the first row is the taller corner row.
export function crossGroupingHeight(levels, { withCorner = false } = {}) {
  const h = (levels || []).reduce((sum, lvl) => sum + lvl.rows.length * VALUE_ROW_H, 0);
  return withCorner && h > 0 ? h + CORNER_ROW_H - VALUE_ROW_H : h;
}
