// Pure helpers for the Contexts page's tree panel: where a tree comes from in
// plain words (the group headings), the kind of member as a word, the one
// count per row, who may change a tree, and the panel's empty-state copy.
// Kept free of React so every branch is unit-tested directly.

import { memberKindLabel } from '@ui/utils/contextStyles';

// The label of the "search every attribute" switch in the tree panel. The
// context search matches every value a source sent (a CMDB reference, an HR
// number), not only descriptions, so the label says "other fields".
export const CONTEXT_EXTENDED_SEARCH_LABEL = 'Also search other fields';

const MANAGER_HIERARCHY = 'manager-hierarchy';

// Order of the source groups: imported, derived, manager hierarchy, created here.
const CLASS_ORDER = { synced: 0, generated: 1, hierarchy: 2, manual: 3 };

function sourceClass(root) {
  if (root?.variant === 'synced') return 'synced';
  if (root?.variant === 'generated') return root.sourceAlgorithmName === MANAGER_HIERARCHY ? 'hierarchy' : 'generated';
  return 'manual';
}

// The rule that derived a tree, by the name it has under Admin, so a reader
// can tell which rule made it ("Department from Principal").
function derivedDetail(root) {
  return root.sourceAlgorithmDisplayName || root.sourceAlgorithmName || null;
}

// The heading a root is listed under: { key, title, detail }.
//   synced     → "Imported" · <system>
//   generated  → "Derived" · <the rule's display name>
//   manager    → "Manager hierarchy" · <system>
//   manual     → "Created here"
export function sourceGroupOf(root) {
  const cls = sourceClass(root);
  const sys = root?.scopeSystemName || null;
  if (cls === 'synced') return { key: `synced:${root.scopeSystemId ?? ''}`, cls, title: 'Imported', detail: sys };
  if (cls === 'hierarchy') return { key: `hierarchy:${root.scopeSystemId ?? ''}`, cls, title: 'Manager hierarchy', detail: sys };
  if (cls === 'generated') {
    return { key: `generated:${root.sourceAlgorithmName ?? ''}:${root.scopeSystemId ?? ''}`, cls, title: 'Derived', detail: derivedDetail(root) };
  }
  return { key: 'manual', cls, title: 'Created here', detail: null };
}

// The roots split into source groups, in CLASS_ORDER and, inside a class, in
// the order the roots arrive: [{ key, title, detail, variant, roots }].
export function groupBySource(roots) {
  const groups = new Map();
  for (const r of roots || []) {
    const g = sourceGroupOf(r);
    if (!groups.has(g.key)) groups.set(g.key, { ...g, variant: r.variant, roots: [] });
    groups.get(g.key).roots.push(r);
  }
  return [...groups.values()].sort((a, b) => CLASS_ORDER[a.cls] - CLASS_ORDER[b.cls]);
}

// The roots in the order the panel lists them (group by group), so "the first
// root" — the one selected when nothing is remembered — is the first one shown.
export function orderBySource(roots) {
  return groupBySource(roots).flatMap(g => g.roots);
}

// May the user change this tree in place (add a sub-unit, rename, move, delete,
// refresh)? Only with the write permission, and never an imported tree: the
// next import would overwrite it, and the API refuses.
export function isEditableTree(variant, canWrite) {
  return !!canWrite && variant !== 'synced';
}

// Tabs whose roots can hold different kinds of member side by side (three roots
// called "Tags"): there a root names its kind ("Tags · People"). On Organisation
// the Show switch says it, on Applications it is always resources.
const MIXED_KIND_TABS = new Set(['Tag', 'Segment', 'Other']);
export function rootKindSuffix(tab, root) {
  return MIXED_KIND_TABS.has(tab) && root?.targetType ? memberKindLabel(root.targetType) : null;
}

// Does the tab let the user filter on the kind of member? The same tabs.
export function hasKindFilter(tab) {
  return MIXED_KIND_TABS.has(tab);
}

const SINGULAR = { People: 'person', Accounts: 'account', Resources: 'resource', Systems: 'system', Members: 'member' };

// "12 accounts" / "1 account" / "3 people".
export function countWords(n, targetType) {
  const plural = memberKindLabel(targetType);
  return `${n} ${n === 1 ? SINGULAR[plural] : plural.toLowerCase()}`;
}

// A row's one count — everyone in the unit including its sub-units — and the
// title that splits it: "37 accounts (12 directly in this unit)". Null when the
// row carries no counts.
export function rowCount(node) {
  const direct = node?.directMemberCount;
  const total = node?.totalMemberCount;
  if (typeof direct !== 'number' && typeof total !== 'number') return null;
  const shown = Math.max(total || 0, direct || 0);
  const title = shown > (direct || 0)
    ? `${countWords(shown, node.targetType)} (${direct || 0} directly in this unit)`
    : countWords(shown, node.targetType);
  return { value: shown, title };
}

// The Organisation kinds as words for the empty state: "units of people".
const UNIT_OF = { Identity: 'people', Principal: 'accounts', Resource: 'resources' };
const ORIGIN_OF = {
  Identity: 'an HR import or from the manager-hierarchy rule',
  Principal: 'an import, or from a rule over account attributes such as department',
  Resource: 'an import, or from a rule over resource attributes',
};
const TAB_EMPTY = {
  LogicalApplication: 'No applications yet. Applications come from an import of an application catalogue, or you create one by hand.',
  Tag: 'No tags yet. Create one by hand to label people, accounts or resources.',
  Segment: 'No segments yet. Segments come from a rule over the data, such as location or account type, or you create one by hand.',
};

// What the panel says when the tab (and kind) has no trees at all.
export function emptyTreesCopy(tab, kind) {
  if (tab === 'OrganizationalUnit') {
    if (!UNIT_OF[kind]) return 'No units yet. Units come from an HR import or from a rule over the data. Set up an import under Admin › Crawlers, or create a unit by hand.';
    return `No units of ${UNIT_OF[kind]} yet. Units of ${UNIT_OF[kind]} come from ${ORIGIN_OF[kind]}. Set up an import under Admin › Crawlers, or create a unit by hand.`;
  }
  return TAB_EMPTY[tab] || 'Nothing here yet.';
}

// The filter options, in the panel's words.
export const SOURCE_OPTIONS = [
  { value: 'synced', label: 'Imported' },
  { value: 'generated', label: 'Derived' },
  { value: 'manual', label: 'Created here' },
];
export const KIND_FILTER_OPTIONS = ['Identity', 'Principal', 'Resource', 'System']
  .map(value => ({ value, label: memberKindLabel(value) }));

// The tooltip of a curated derived unit — renamed and/or moved by someone here,
// kept when the tree is refreshed. Null when nothing was changed.
export function editedTitle(node) {
  if (node?.variant !== 'generated') return null;
  const parts = [node.userRenamed && 'renamed', node.userReparented && 'moved'].filter(Boolean);
  if (!parts.length) return null;
  return `Changed here (${parts.join(' and ')}). Kept when the tree is refreshed.`;
}
