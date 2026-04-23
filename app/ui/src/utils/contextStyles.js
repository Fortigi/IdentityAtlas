// Visual language for the Contexts tab.
// Two orthogonal dimensions — variant (who produced this context) and
// targetType (what it contains) — each with a distinct visual treatment.

export const VARIANT_META = {
  synced:    { label: 'Synced',    borderClass: 'border-blue-500',   dotClass: 'bg-blue-500',   textClass: 'text-blue-700' },
  generated: { label: 'Generated', borderClass: 'border-emerald-500', dotClass: 'bg-emerald-500', textClass: 'text-emerald-700' },
  manual:    { label: 'Manual',    borderClass: 'border-amber-600',  dotClass: 'bg-amber-600',  textClass: 'text-amber-700' },
};

export const TARGET_TYPE_META = {
  Identity:  { label: 'Identity',  badgeClass: 'bg-purple-100 text-purple-700 border-purple-200' },
  Resource:  { label: 'Resource',  badgeClass: 'bg-orange-100 text-orange-700 border-orange-200' },
  Principal: { label: 'Principal', badgeClass: 'bg-gray-100 text-gray-700 border-gray-200' },
  System:    { label: 'System',    badgeClass: 'bg-yellow-100 text-yellow-800 border-yellow-200' },
};

export function variantMeta(variant) {
  return VARIANT_META[variant] || { label: variant || 'Unknown', borderClass: 'border-gray-300', dotClass: 'bg-gray-300', textClass: 'text-gray-600' };
}

export function targetTypeMeta(t) {
  return TARGET_TYPE_META[t] || { label: t || 'Unknown', badgeClass: 'bg-gray-100 text-gray-700 border-gray-200' };
}
