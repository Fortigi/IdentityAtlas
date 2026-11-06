import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';

// Which tree a context belongs to, and whether it can be adjusted here:
// GET /api/context-trees/resolve?contextId=… → { treeKey, name, canAdjust, reason? }.
// Read only while `enabled` (a menu that is open, a header for someone who may
// change trees). `state` is what an "Adjust tree" action shows:
//   'loading' | 'ready' (open it) | 'blocked' (with `reason`) | 'failed'.

export function resolveState({ data, loading, error }) {
  if (error) return { state: 'failed', reason: 'Could not check whether this tree can be adjusted.' };
  if (loading || !data) return { state: 'loading', reason: null };
  if (!data.canAdjust) return { state: 'blocked', reason: data.reason || 'This tree cannot be adjusted here.' };
  return { state: 'ready', reason: null };
}

// The title of the tab the Adjust tree screen opens in.
export function adjustTabTitle(name) {
  return `Adjust: ${name || 'tree'}`;
}

export function useTreeResolve(contextId, enabled) {
  const { authFetch } = useAuth();
  const result = useFetch(
    contextId ? `/api/context-trees/resolve?contextId=${encodeURIComponent(contextId)}` : null,
    { authFetch, enabled: !!enabled && !!contextId },
  );
  return { tree: result.data, ...resolveState(result) };
}
