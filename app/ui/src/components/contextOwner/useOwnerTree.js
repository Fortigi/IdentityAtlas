// What a context owner's sub-tabs and tree draw (OwnerTree.jsx), from
// GET /api/context-owner/tree: what they answer for and the sub-units below it.

import { useCallback, useMemo, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { findNodeById } from '@ui/components/contexts/useContextTreeEdits';
import { effectiveTab, tabOf, templateTabs } from '@ui/components/contexts/templateTabs.helpers';

// A sub-unit sits on the tab of the tree it is in.
function rootTab(roots, node) {
  return tabOf(roots.find(r => findNodeById([r], node.id)) || node);
}

/** The tabs that hold something, the active one, and that tab's roots. Pure. */
export function ownerTreeView(roots, selectedId, chosenTab) {
  const tabs = templateTabs(roots).filter(t => t.count > 0);
  const selected = findNodeById(roots, selectedId);
  const active = selected ? rootTab(roots, selected) : effectiveTab(tabs, chosenTab);
  return { tabs, active, nodes: roots.filter(r => tabOf(r) === active) };
}

// The page's one row of tabs. An owner reads Organisation, Applications and
// Business roles as kinds of thing they answer for, side by side — not as
// "contexts" and "business roles" with sub-tabs under the first.
export const ROLES_TAB = 'BusinessRoles';
export const UNITS_TAB = 'Units';

/** The row: the trees' tabs (one plain tab while there is no tree), then Business roles. Pure. */
export function ownerPageTabs(tree, hasRoles) {
  if (!hasRoles) return tree.ready ? tree.tabs : [];
  const own = tree.ready ? tree.tabs : [{ key: UNITS_TAB, label: 'Your units' }];
  return [...own, { key: ROLES_TAB, label: 'Business roles' }];
}

/** The tab that is lit. Pure. */
export function ownerActiveTab(tree, showRoles) {
  if (showRoles) return ROLES_TAB;
  return tree.ready ? tree.active : UNITS_TAB;
}

/**
 * The tree for the page: `ready` once it is there (a failed read leaves the plain
 * list), `pending` while it loads, and what the tabs and the tree draw.
 */
export function useOwnerTree(selectedId, onSelect) {
  const { authFetch } = useAuth();
  const { data, loading } = useFetch('/api/context-owner/tree', { authFetch });
  const [chosenTab, setChosenTab] = useState(null);
  const roots = useMemo(() => (Array.isArray(data) ? data : []), [data]);
  const view = useMemo(() => ownerTreeView(roots, selectedId, chosenTab), [roots, selectedId, chosenTab]);
  const openTab = useCallback((tab) => {
    setChosenTab(tab);
    const first = roots.find(r => tabOf(r) === tab);
    if (first) onSelect(first.id);
  }, [roots, onSelect]);
  return { ready: roots.length > 0, pending: loading, ...view, openTab };
}
