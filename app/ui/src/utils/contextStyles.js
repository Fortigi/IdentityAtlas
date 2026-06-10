// Visual language for the Contexts tab.
// Two orthogonal dimensions — variant (who produced this context) and
// targetType (what it contains) — each with a distinct visual treatment.
//
// Every text/badge class ships with a dark: variant: these metas are consumed
// raw by every Contexts component, so a missing dark variant breaks the whole
// tab in dark mode (contextStyles.test.js guards against regressions).

export const VARIANT_META = {
  synced:    { label: 'Synced',    borderClass: 'border-blue-500',    dotClass: 'bg-blue-500',    textClass: 'text-blue-700 dark:text-blue-400' },
  generated: { label: 'Generated', borderClass: 'border-emerald-500', dotClass: 'bg-emerald-500', textClass: 'text-emerald-700 dark:text-emerald-400' },
  manual:    { label: 'Manual',    borderClass: 'border-amber-600',   dotClass: 'bg-amber-600',   textClass: 'text-amber-700 dark:text-amber-400' },
};

export const TARGET_TYPE_META = {
  Identity:  { label: 'Identity',  badgeClass: 'bg-purple-100 text-purple-700 border-purple-200 dark:bg-purple-900/30 dark:text-purple-300 dark:border-purple-700' },
  Resource:  { label: 'Resource',  badgeClass: 'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-900/30 dark:text-orange-300 dark:border-orange-700' },
  // Principal gets its own hue (sky) so it isn't visually identical to the Unknown fallback.
  Principal: { label: 'Principal', badgeClass: 'bg-sky-100 text-sky-700 border-sky-200 dark:bg-sky-900/30 dark:text-sky-300 dark:border-sky-700' },
  System:    { label: 'System',    badgeClass: 'bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-300 dark:border-yellow-700' },
};

export function variantMeta(variant) {
  return VARIANT_META[variant] || { label: variant || 'Unknown', borderClass: 'border-gray-300', dotClass: 'bg-gray-300', textClass: 'text-gray-600 dark:text-gray-400' };
}

export function targetTypeMeta(t) {
  return TARGET_TYPE_META[t] || { label: t || 'Unknown', badgeClass: 'bg-gray-100 text-gray-700 border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600' };
}

// "Edited" treatment for a generated context an analyst has curated (renamed
// and/or re-parented). Generated nodes are normally emerald; once touched we
// tint them amber — the same hue as manual contexts — so "analyst has changed
// this" reads consistently across the tab. Returns null when there's nothing
// to mark (synced/manual nodes, or untouched generated nodes).
export function editedMeta(node) {
  if (!node || node.variant !== 'generated') return null;
  const renamed = !!node.userRenamed;
  const reparented = !!node.userReparented;
  if (!renamed && !reparented) return null;
  const parts = [];
  if (renamed) parts.push('renamed');
  if (reparented) parts.push('moved');
  return {
    label: 'Edited',
    title: `Analyst-curated (${parts.join(' + ')}) — kept when the plugin re-runs`,
    ringClass: 'ring-1 ring-amber-400 dark:ring-amber-500',
    badgeClass: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700',
  };
}
