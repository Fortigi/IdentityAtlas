// Pure helpers for the Contexts page's sub-tabs: one tab per template
// (Organisation · Applications · Tags · Segments, plus Other only when some
// root has no template), and in Organisation one tree kind at a time.

import { categoryMeta, CATEGORY_ORDER, MEMBER_KINDS, memberKindLabel } from '@ui/utils/contextStyles';

// The tab a root belongs to: its template, or Other for none / an unknown one.
export function tabOf(root) {
  return CATEGORY_ORDER.includes(root?.contextCategory) ? root.contextCategory : 'Other';
}

// [{ key, label, count }] in CATEGORY_ORDER, count = how many trees (roots) the
// tab holds. The four templates always show (an empty tab is still a place to
// create one); Other only when it has roots. The count picks the opening tab;
// it is not drawn (a reader takes "Organisation 9" for nine units).
export function templateTabs(roots) {
  const counts = new Map();
  for (const r of roots || []) counts.set(tabOf(r), (counts.get(tabOf(r)) || 0) + 1);
  return CATEGORY_ORDER
    .filter(k => k !== 'Other' || counts.has('Other'))
    .map(k => ({ key: k, label: categoryMeta(k).groupLabel, count: counts.get(k) || 0 }));
}

// The Organisation "Show" switch: People · Accounts · Resources, offering only
// the kinds that have organisation trees — which kinds exist follows from the
// systems connected, so an empty kind is never offered as a place to land.
export function kindOptions(roots) {
  return MEMBER_KINDS
    .map(kind => ({
      key: kind,
      label: memberKindLabel(kind),
      count: (roots || []).filter(r => tabOf(r) === 'OrganizationalUnit' && r.targetType === kind).length,
    }))
    .filter(o => o.count > 0);
}

// The tab to show: the chosen one while it still exists, else the first tab
// with any roots, else Organisation.
export function effectiveTab(tabs, chosen) {
  if (chosen && tabs.some(t => t.key === chosen)) return chosen;
  return tabs.find(t => t.count > 0)?.key || 'OrganizationalUnit';
}

// The kind to show in Organisation: the chosen one while it is still offered,
// else the first offered kind, else none (Organisation has no trees at all).
export function effectiveKind(options, chosen) {
  if (chosen && options.some(o => o.key === chosen)) return chosen;
  return options[0]?.key || null;
}

// The roots the left pane lists for the active tab (and, in Organisation, kind).
export function rootsForTab(roots, tab, kind) {
  return (roots || []).filter(r => tabOf(r) === tab && (tab !== 'OrganizationalUnit' || r.targetType === kind));
}
