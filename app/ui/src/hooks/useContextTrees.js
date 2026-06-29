// Fetches and caches the list of Context roots + the currently-selected
// root's subtree. A single hook for the Contexts tab — the tree selector
// and the tree/list view both consume its output.

import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';

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

export function useContextSubtree(rootId) {
  const { authFetch } = useAuth();
  const { data: nodes, loading, error, reload } = useFetch(
    rootId ? `/api/contexts/tree?root=${encodeURIComponent(rootId)}` : null,
    {
      authFetch,
      enabled: !!rootId,
      initialData: [],
      transform: (body) => (Array.isArray(body) ? body : []),
      onError: (err) => console.error('Failed to load subtree:', err),
    },
  );
  return { nodes, loading, error: error ? (error.message || 'Failed to load subtree') : null, reload };
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
