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
