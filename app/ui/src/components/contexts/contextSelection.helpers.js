// Pure helpers for the Contexts page's selection: which context is shown on
// the right, remembered per template tab (and, in Organisation, per kind).

// The key a selection is remembered under: the tab, plus the kind in Organisation.
export function viewKeyOf(tab, kind) {
  return tab === 'OrganizationalUnit' ? `${tab}:${kind}` : tab;
}

// The selected context of a view: the remembered one, else the first root.
export function selectedIdFor(remembered, viewKey, roots) {
  return remembered?.[viewKey] || roots?.[0]?.id || null;
}

// The remembered selections without this view's — after its context went away.
export function forgetView(remembered, viewKey) {
  const next = { ...(remembered || {}) };
  delete next[viewKey];
  return next;
}

function contains(node, id) {
  return node.id === id || (node.children || []).some(c => contains(c, id));
}

// The top-level tree (root) that holds context `id`, among the loaded ones.
export function rootContaining(forest, id) {
  if (!id) return null;
  return (forest || []).find(root => contains(root, id)) || null;
}

// A person can be dragged to another team only in a tree the manager-hierarchy
// plugin produced — the plugin decides, not the context type's name.
export function isMemberMovableTree(root) {
  return root?.sourceAlgorithmName === 'manager-hierarchy';
}
