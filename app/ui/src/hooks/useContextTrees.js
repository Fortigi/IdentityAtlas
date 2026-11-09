// The Contexts tab's data: the list of root contexts, and the forest the left
// pane shows — every root of the tab as a top-level node, each root's subtree
// read from /api/contexts/tree only once it is expanded or selected.

import { useCallback, useMemo, useRef, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { isExtendedSearchActive } from '@ui/utils/matchedOn';

export function useContextRoots() {
  const { authFetch } = useAuth();
  const { data: roots, loading, error, reload } = useFetch('/api/contexts', {
    authFetch,
    initialData: [],
    transform: (body) => body.data || [],
    onError: (err) => console.error('Failed to load context roots:', err),
  });
  return { roots, loading, error: error ? (error.message || 'Failed to load contexts') : null, reload };
}

// The /api/contexts/tree URL for one root's subtree.
export function subtreeUrl(rootId) {
  return `/api/contexts/tree?root=${encodeURIComponent(rootId)}`;
}

// The left pane's top level: every root, with its loaded subtree merged in, or
// marked `childrenPending` while its subtree has not been read. Pure, for the
// tests. The roots row wins for the root itself — it carries what the tree
// endpoint does not (plugin and system names) and is re-read after every edit;
// the subtree adds the children.
export function forestNodes(roots, loaded) {
  return (roots || []).map((r) => {
    const tree = loaded.get(r.id);
    if (!tree) return { ...r, children: [], childrenPending: true };
    return { ...tree, ...r, children: tree.children || [] };
  });
}

// The roots of a tab as one navigable forest. `load(rootId)` reads a root's
// subtree once (expanding it again does not refetch); `reload()` re-reads
// every subtree already loaded, after an edit changed structure or counts.
// A failed read leaves the root without children rather than pending forever.
export function useContextForest(roots) {
  const { authFetch } = useAuth();
  const [loaded, setLoaded] = useState(() => new Map());
  const requested = useRef(new Set());

  const fetchRoot = useCallback(async (rootId) => {
    let tree = { id: rootId, children: [] };
    try {
      const r = await authFetch(subtreeUrl(rootId));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      tree = (Array.isArray(body) && body[0]) || tree;
    } catch (err) {
      console.error('Failed to load subtree:', err);
    }
    setLoaded(prev => new Map(prev).set(rootId, tree));
  }, [authFetch]);

  const load = useCallback((rootId) => {
    if (!rootId || requested.current.has(rootId)) return;
    requested.current.add(rootId);
    fetchRoot(rootId);
  }, [fetchRoot]);

  const reload = useCallback(
    () => Promise.all([...loaded.keys()].map(fetchRoot)),
    [loaded, fetchRoot],
  );

  const nodes = useMemo(() => forestNodes(roots, loaded), [roots, loaded]);
  return { nodes, load, reload };
}

// The search URL for the Contexts pane, or null for no search. Searching looks
// at every level (the API drops the roots-only rule), so a logical
// application under its catalogue is found directly. Pure, for the tests.
export function contextSearchUrl(term, extended) {
  const t = String(term ?? '').trim();
  if (!t) return null;
  const qs = new URLSearchParams({ search: t });
  if (isExtendedSearchActive(extended, t)) qs.set('extendedSearch', 'true');
  return `/api/contexts?${qs}`;
}

export function useContextSearch(term, extended) {
  const { authFetch } = useAuth();
  const url = contextSearchUrl(term, extended);
  const { data: results, loading, error } = useFetch(url, {
    authFetch,
    enabled: !!url,
    initialData: [],
    transform: (body) => body.data || [],
    onError: (err) => console.error('Context search failed:', err),
  });
  return { results: url ? results : [], loading: !!url && loading, error: error ? (error.message || 'Search failed') : null };
}

// Flattens a nested tree (children-of-children) into an indent-aware list.
// Used by the list view.
export function flattenTree(nodes, depth = 0, out = []) {
  for (const n of nodes || []) {
    out.push({ ...n, _depth: depth });
    if (n.children && n.children.length) flattenTree(n.children, depth + 1, out);
  }
  return out;
}
