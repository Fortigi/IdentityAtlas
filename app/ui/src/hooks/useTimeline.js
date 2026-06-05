import { useEffect, useState } from 'react';

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
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const urlFn = ENDPOINT[entityKind];
    if (!enabled || !entityId || !urlFn) return undefined;
    let cancelled = false;
    setLoading(true);
    const url = `${urlFn(entityId)}?sinceDays=${sinceDays}&limit=${limit}`;
    authFetch(url)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled) setData(d || { events: [], addedCount: 0, removedCount: 0, changedCount: 0, sinceDays }); })
      .catch(() => { if (!cancelled) setData({ events: [], addedCount: 0, removedCount: 0, changedCount: 0, sinceDays }); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [entityKind, entityId, authFetch, sinceDays, limit, enabled]);

  return {
    events: data?.events || [],
    addedCount: data?.addedCount || 0,
    removedCount: data?.removedCount || 0,
    changedCount: data?.changedCount || 0,
    sinceDays: data?.sinceDays || sinceDays,
    loading,
  };
}
