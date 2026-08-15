// Pure reducer for the tree-aware column-fold toggle. Extracted from MatrixView's
// toggleCollapse callback so the branch-heavy set arithmetic is unit-testable and
// stays under the complexity gate.

import { collapseKey } from './columnModel';

// Unfolding a group drops to the NEXT sort level (its child groups stay folded)
// unless it's already the deepest level.
function unfoldToNextLevel(next, users, key, level, nAttr) {
  next.delete(key);
  if (level + 1 >= nAttr) return;
  for (const u of users) {
    if (collapseKey(u.sortKeys, level) === key) next.add(collapseKey(u.sortKeys, level + 1));
  }
}

// Folding a group also clears any deeper sub-folds it now hides.
function foldAndClearDeeper(next, users, key, level, nAttr) {
  next.add(key);
  for (const u of users) {
    if (collapseKey(u.sortKeys, level) !== key) continue;
    for (let L = level + 1; L < nAttr; L++) next.delete(collapseKey(u.sortKeys, L));
  }
}

// Next collapsed-set for a fold toggle at (sortKeys, level).
export function toggleCollapsedGroups(prev, users, sortKeys, level, nAttr) {
  const key = collapseKey(sortKeys, level);
  const next = new Set(prev);
  if (next.has(key)) unfoldToNextLevel(next, users, key, level, nAttr);
  else foldAndClearDeeper(next, users, key, level, nAttr);
  return next;
}
