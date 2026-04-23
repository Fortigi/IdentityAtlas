import { useCallback, useMemo, useState } from 'react';
import {
  fetchCategoryItems,
  fetchEntityCore,
  getRootNodes,
  isExpandableItem,
  extrasFromCore,
} from '../components/entityGraphShape';

// ─── useExpandableGraph ──────────────────────────────────────────────
// Drives the fanout-on-click behaviour shared by every entity detail
// page. Given the page's root entity (kind + id + extras) and the
// root-ring node spec, it exposes:
//
//   nodesWithExpansion    — the root-ring array with nested `children`
//                           arrays reflecting the current drill path
//   handleNodeClick(node) — toggles expansion for the clicked node
//                           (expand on first click, collapse on second,
//                           replace siblings when switching branches)
//   expandedPath          — keys of every node currently on the open
//                           branch, used by EntityGraph for styling
//   activeListItems / activeListLabel — the list rendered below the
//                           graph: the items of the deepest category
//                           drilled into, or null when only an item
//                           level is active
//   reset()               — drop the entire expansion (click "clear")
//
// Expansion is a stack of "steps". Each step records the node whose
// click triggered it, plus the children (items or categories) to
// attach under that node. Steps alternate kinds:
//   category-step  (kind='category') — fanout of items under a category
//   item-step      (kind='item')     — fanout of categories under an item

export default function useExpandableGraph({ rootEntityKind, rootEntityId, rootExtras, rootNodes, authFetch }) {
  const [path, setPath] = useState([]);
  const [loading, setLoading] = useState(false);

  // Walk the current drill chain to find which parent entity we're
  // fetching items for. At depth 0 that's the page's root entity; at
  // deeper levels it's the most recent drilled-into item.
  const currentParent = useCallback(() => {
    if (path.length === 0) return { kind: rootEntityKind, id: rootEntityId, extras: rootExtras };
    for (let i = path.length - 1; i >= 0; i--) {
      if (path[i].kind === 'item') {
        return { kind: path[i].parent.k, id: path[i].parent.id, extras: path[i].parent.extras };
      }
    }
    return { kind: rootEntityKind, id: rootEntityId, extras: rootExtras };
  }, [path, rootEntityKind, rootEntityId, rootExtras]);

  const handleNodeClick = useCallback(async (node) => {
    if (!node || node.overflow) return;

    // Already on the open chain? Collapse back to just before this node.
    const pathIdx = path.findIndex(p => p.nodeKey === node.key);
    if (pathIdx >= 0) {
      setPath(path.slice(0, pathIdx));
      return;
    }

    if (node.kind === 'item') {
      if (!isExpandableItem(node.entityKind)) return;
      setLoading(true);
      try {
        const core = await fetchEntityCore(node.entityKind, node.entityId, authFetch);
        if (!core) return;
        const extras = extrasFromCore(node.entityKind, core);
        const categoryNodes = getRootNodes(node.entityKind, core, extras);
        setPath(prev => [
          ...prev,
          {
            nodeKey: node.key,
            kind: 'item',
            parent: { k: node.entityKind, id: node.entityId, label: node.label, extras },
            children: categoryNodes,
          },
        ]);
      } finally {
        setLoading(false);
      }
      return;
    }

    // Category click — fetch the list for this category under its
    // current parent (root entity at depth 0, otherwise the most
    // recently drilled-into item).
    const parent = currentParent();
    setLoading(true);
    try {
      const items = await fetchCategoryItems(parent.kind, parent.id, node.key, authFetch, parent.extras || {});
      setPath(prev => [
        ...prev,
        {
          nodeKey: node.key,
          kind: 'category',
          parent: { k: parent.kind, id: parent.id, extras: parent.extras },
          children: items,
        },
      ]);
    } finally {
      setLoading(false);
    }
  }, [path, authFetch, currentParent]);

  // Turn the flat path into the nested tree EntityGraph wants.
  const nodesWithExpansion = useMemo(() => {
    function attach(level, remainingPath) {
      if (remainingPath.length === 0) return level;
      const [first, ...rest] = remainingPath;
      return level.map(n => {
        if (n.key === first.nodeKey) {
          return { ...n, children: attach(first.children, rest) };
        }
        return n;
      });
    }
    return attach(rootNodes, path);
  }, [rootNodes, path]);

  const expandedPath = useMemo(() => path.map(p => p.nodeKey), [path]);

  // The list below mirrors the deepest *category* step — that's the
  // level where the user last asked "show me the list of things".
  // Depth 0 with no path means nothing is selected yet.
  const [activeListItems, activeListLabel, activeListKind] = useMemo(() => {
    for (let i = path.length - 1; i >= 0; i--) {
      if (path[i].kind === 'category') {
        return [path[i].children, deriveLabel(rootNodes, path, i), path[i].nodeKey];
      }
    }
    return [null, null, null];
  }, [path, rootNodes]);

  const reset = useCallback(() => setPath([]), []);

  return {
    nodesWithExpansion,
    expandedPath,
    handleNodeClick,
    activeListItems,
    activeListLabel,
    activeListKind,
    loading,
    reset,
    pathDepth: path.length,
  };
}

// Build a breadcrumb-style label like "Access Packages" or
// "Access Packages → BR-Employee-Base → Resources" so the list header
// tells you exactly which category you drilled into.
function deriveLabel(rootNodes, path, upto) {
  const parts = [];
  let level = rootNodes;
  for (let i = 0; i <= upto; i++) {
    const step = path[i];
    const match = level.find(n => n.key === step.nodeKey);
    if (match) parts.push(match.label);
    level = step.children;
  }
  return parts.join(' → ');
}
