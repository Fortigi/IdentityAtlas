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

// The four context templates (phase B of the ontology) plus "Other" for a
// context whose contextCategory is null (a contextType the backfill did not
// know). Hues stay clear of the variant (blue/emerald/amber) and target-type
// (purple/orange/sky/yellow) metas so the three dimensions never look alike.
// `groupLabel` is the heading the tree selector groups roots under.
export const CATEGORY_META = {
  OrganizationalUnit: {
    label: 'Organisation', groupLabel: 'Organisation',
    description: 'A unit of the organisation: department, team, cost center, project.',
    badgeClass: 'bg-teal-100 text-teal-800 border-teal-200 dark:bg-teal-900/30 dark:text-teal-300 dark:border-teal-700',
  },
  LogicalApplication: {
    label: 'Application', groupLabel: 'Applications',
    description: 'A logical application: the resources that together make up one system.',
    badgeClass: 'bg-indigo-100 text-indigo-800 border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-300 dark:border-indigo-700',
  },
  Tag: {
    label: 'Tag', groupLabel: 'Tags',
    description: 'A label an analyst attaches to anything.',
    badgeClass: 'bg-pink-100 text-pink-800 border-pink-200 dark:bg-pink-900/30 dark:text-pink-300 dark:border-pink-700',
  },
  Segment: {
    label: 'Segment', groupLabel: 'Segments',
    description: 'A slice of the data: a location, a type, a system membership.',
    badgeClass: 'bg-lime-100 text-lime-800 border-lime-200 dark:bg-lime-900/30 dark:text-lime-300 dark:border-lime-700',
  },
};

// Grouping order in the tree selector: the four templates, then Other.
export const CATEGORY_ORDER = ['OrganizationalUnit', 'LogicalApplication', 'Tag', 'Segment', 'Other'];

const OTHER_CATEGORY_META = {
  label: 'Other', groupLabel: 'Other',
  description: 'No template: the context type is not one of the four templates.',
  badgeClass: 'bg-stone-100 text-stone-700 border-stone-200 dark:bg-stone-800 dark:text-stone-300 dark:border-stone-600',
};

export function categoryMeta(c) {
  return CATEGORY_META[c] || OTHER_CATEGORY_META;
}

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
