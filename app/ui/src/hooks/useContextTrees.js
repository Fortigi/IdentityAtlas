// Fetches and caches the list of Context roots + the currently-selected
// root's subtree. A single hook for the Contexts tab — the tree selector
// and the tree/list view both consume its output.

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
