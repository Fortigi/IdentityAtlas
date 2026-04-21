// Fetches and caches the list of Context roots + the currently-selected
// root's subtree. A single hook for the Contexts tab — the tree selector
// and the tree/list view both consume its output.

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthGate';

export function useContextRoots() {
  const { authFetch } = useAuth();
  const [roots, setRoots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const reload = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await authFetch('/api/contexts');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      setRoots(body.data || []);
    } catch (err) {
      console.error('Failed to load context roots:', err);
      setError(err.message || 'Failed to load contexts');
    } finally {
      setLoading(false);
    }
  }, [authFetch]);

  useEffect(() => { reload(); }, [reload]);

  return { roots, loading, error, reload };
}

export function useContextSubtree(rootId) {
  const { authFetch } = useAuth();
  const [nodes, setNodes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const reload = useCallback(async () => {
    if (!rootId) { setNodes([]); return; }
    setLoading(true); setError(null);
    try {
      const r = await authFetch(`/api/contexts/tree?root=${encodeURIComponent(rootId)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      setNodes(Array.isArray(body) ? body : []);
    } catch (err) {
      console.error('Failed to load subtree:', err);
      setError(err.message || 'Failed to load subtree');
    } finally {
      setLoading(false);
    }
  }, [authFetch, rootId]);

  useEffect(() => { reload(); }, [reload]);

  return { nodes, loading, error, reload };
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
