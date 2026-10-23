// Pure helpers for ContextTreeSelector — kept out of the component file (the
// react-refresh fast-refresh rule) so they can be unit-tested directly.

import { categoryMeta, CATEGORY_ORDER } from '@ui/utils/contextStyles';

// Where a tree came from, as the caption under its name: the plugin for a
// generated tree, the source system for a synced one. A manual tree has no
// source but the analyst, which the variant colour already says.
export function rootCaption(n) {
  if (n.variant === 'generated') return n.sourceAlgorithmDisplayName || n.sourceAlgorithmName || null;
  if (n.variant === 'synced') return n.scopeSystemName || null;
  return null;
}

// Roots grouped by template (Organisation · Applications · Tags · Segments ·
// Other), in CATEGORY_ORDER; a null contextCategory lands under Other.
// Returns [groupLabel, roots[]] pairs, empty groups left out.
export function groupRootsByCategory(roots) {
  const map = new Map();
  for (const r of roots) {
    const key = CATEGORY_ORDER.includes(r.contextCategory) ? r.contextCategory : 'Other';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return CATEGORY_ORDER.filter(k => map.has(k)).map(k => [categoryMeta(k).groupLabel, map.get(k)]);
}
