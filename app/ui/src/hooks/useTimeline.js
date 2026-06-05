import { useEffect, useState } from 'react';

// ─── useTimeline ─────────────────────────────────────────────────────
// Fetches /api/user/:id/timeline — the unified attribute + relationship
// change stream for the user-detail Timeline tab. Mirrors useRecentChanges
// but: (a) the window (sinceDays) is caller-controlled for the range
// selector, and (b) `enabled` defers the fetch until the tab is opened, so
// every user-page open doesn't run the larger query.
//
// Returns { events, addedCount, removedCount, changedCount, sinceDays, loading }.
export default function useTimeline(userId, authFetch, { sinceDays = 90, limit = 200, enabled = true } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !userId) return undefined;
    let cancelled = false;
    setLoading(true);
    const url = `/api/user/${encodeURIComponent(userId)}/timeline?sinceDays=${sinceDays}&limit=${limit}`;
    authFetch(url)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled) setData(d || { events: [], addedCount: 0, removedCount: 0, changedCount: 0, sinceDays }); })
      .catch(() => { if (!cancelled) setData({ events: [], addedCount: 0, removedCount: 0, changedCount: 0, sinceDays }); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [userId, authFetch, sinceDays, limit, enabled]);

  return {
    events: data?.events || [],
    addedCount: data?.addedCount || 0,
    removedCount: data?.removedCount || 0,
    changedCount: data?.changedCount || 0,
    sinceDays: data?.sinceDays || sinceDays,
    loading,
  };
}
