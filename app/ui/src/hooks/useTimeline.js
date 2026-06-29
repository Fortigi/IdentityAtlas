import { useFetch } from '@ui/hooks/useFetch';

// ─── useTimeline ─────────────────────────────────────────────────────
// Fetches /api/<kind>/:id/timeline — the unified attribute + relationship
// change stream for an entity-detail Timeline tab. Mirrors useRecentChanges
// but: (a) the window (sinceDays) is caller-controlled for the range
// selector, and (b) `enabled` defers the fetch until the tab is opened, so
// every detail-page open doesn't run the larger query.
//
// Returns { events, addedCount, removedCount, changedCount, sinceDays, loading }.
const ENDPOINT = {
  user:             (id) => `/api/user/${encodeURIComponent(id)}/timeline`,
  resource:         (id) => `/api/resources/${encodeURIComponent(id)}/timeline`,
  'access-package': (id) => `/api/access-package/${encodeURIComponent(id)}/timeline`,
  identity:         (id) => `/api/identities/${encodeURIComponent(id)}/timeline`,
  context:          (id) => `/api/contexts/${encodeURIComponent(id)}/timeline`,
};

export default function useTimeline(entityKind, entityId, authFetch, { sinceDays = 90, limit = 200, enabled = true } = {}) {
  const urlFn = ENDPOINT[entityKind];
  const url = (enabled && entityId && urlFn)
    ? `${urlFn(entityId)}?sinceDays=${sinceDays}&limit=${limit}`
    : null;
  // A non-ok/failed fetch leaves `data` null; the defaults below render an empty
  // timeline (matches the previous fallback object). `error` is intentionally
  // not surfaced — the Timeline tab just shows "no changes".
  const { data, loading } = useFetch(url, { authFetch });

  return {
    events: data?.events || [],
    addedCount: data?.addedCount || 0,
    removedCount: data?.removedCount || 0,
    changedCount: data?.changedCount || 0,
    sinceDays: data?.sinceDays || sinceDays,
    loading,
  };
}
