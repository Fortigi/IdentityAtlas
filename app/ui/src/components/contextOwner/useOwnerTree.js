// What a context owner's sub-tabs and tree draw (OwnerTree.jsx), from
// GET /api/context-owner/tree: what they answer for and the sub-units below it,
// plus — on the Role portfolios tab — the business roles they answer for whose
// portfolio they do not hold (ownerPortfolios.js).

import { useCallback, useMemo, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { findNodeById } from '@ui/components/contexts/useContextTreeEdits';
import { effectiveTab, tabOf, templateTabs } from '@ui/components/contexts/templateTabs.helpers';
import { categoryMeta } from '@ui/utils/contextStyles';
import { PORTFOLIO_TAB, firstGroupRole } from './ownerPortfolios';

// A sub-unit sits on the tab of the tree it is in.
function rootTab(roots, node) {
  return tabOf(roots.find(r => findNodeById([r], node.id)) || node);
}

/**
 * The tabs that hold something, the active one, and that tab's roots. Role
 * groups count towards Role portfolios, so that tab shows for an owner who
 * holds no portfolio but answers for roles in one. Pure.
 */
export function ownerTreeView(roots, selectedId, chosenTab, roleGroupCount = 0) {
  const tabs = templateTabs(roots)
    .map(t => (t.key === PORTFOLIO_TAB ? { ...t, count: t.count + roleGroupCount } : t))
    .filter(t => t.count > 0);
  const selected = findNodeById(roots, selectedId);
  const active = selected ? rootTab(roots, selected) : effectiveTab(tabs, chosenTab);
  return { tabs, active, nodes: roots.filter(r => tabOf(r) === active) };
}

// The page's one row of tabs: Organisation, Applications, Role portfolios … as
// kinds of thing they answer for, side by side. While the tree cannot load,
// one plain tab stands for their units.
export const UNITS_TAB = 'Units';

/**
 * The row: the trees' tabs, or — while there is no tree — the plain units tab
 * (only when they answer for a context) and Role portfolios. Pure.
 */
export function ownerPageTabs(tree, hasRoleGroups, hasContexts = true) {
  if (tree.ready) return tree.tabs;
  if (!hasRoleGroups) return [];
  const portfolios = { key: PORTFOLIO_TAB, label: categoryMeta(PORTFOLIO_TAB).groupLabel };
  return hasContexts ? [{ key: UNITS_TAB, label: 'Your units' }, portfolios] : [portfolios];
}

/** The tab that is lit. Pure. */
export function ownerActiveTab(tree, roleSelected) {
  if (tree.ready) return tree.active;
  return roleSelected ? PORTFOLIO_TAB : UNITS_TAB;
}

/**
 * The tree for the page: `ready` once it is there (a failed read leaves the plain
 * list), `pending` while it loads, and what the tabs and the tree draw. A tab
 * with no tree of its own (Role portfolios holding only role groups) opens its
 * first role through `onSelectRole`.
 */
export function useOwnerTree(selectedId, onSelect, { roleGroups = [], onSelectRole } = {}) {
  const { authFetch } = useAuth();
  const { data, loading } = useFetch('/api/context-owner/tree', { authFetch });
  const [chosenTab, setChosenTab] = useState(null);
  const roots = useMemo(() => (Array.isArray(data) ? data : []), [data]);
  const view = useMemo(() => ownerTreeView(roots, selectedId, chosenTab, roleGroups.length), [roots, selectedId, chosenTab, roleGroups.length]);
  const openTab = useCallback((tab) => {
    setChosenTab(tab);
    const first = roots.find(r => tabOf(r) === tab);
    const role = tab === PORTFOLIO_TAB ? firstGroupRole(roleGroups) : null;
    if (first) onSelect(first.id);
    else if (role) onSelectRole?.(role);
  }, [roots, onSelect, roleGroups, onSelectRole]);
  return { ready: roots.length > 0, pending: loading, ...view, openTab, chooseTab: setChosenTab };
}
