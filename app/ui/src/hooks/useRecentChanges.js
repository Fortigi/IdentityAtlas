import { useEffect, useMemo, useState } from 'react';

// ─── useRecentChanges ────────────────────────────────────────────────
// Fetches /api/<kind>/:id/recent-changes on mount and exposes it in the
// shape the entity graph + RecentChangesSection both want:
//
//   events       — raw event list from the endpoint
//   addedCount   — how many "added" events landed in the window
//   removedCount — how many "removed" events landed
//   added        — filtered subset for the graph's "Recently Added" node
//   removed      — filtered subset for "Recently Removed"
//   addedIds     — Set of counterpartyId values that were added, so
//                  regular category fanouts can mark those items as
//                  fresh with a glance (yellow fill vs green).
//   sinceDays    — echoed from the endpoint for the UI's "last N days" label

const ENDPOINT = {
  'user':           (id) => `/api/user/${encodeURIComponent(id)}/recent-changes`,
  'resource':       (id) => `/api/resources/${encodeURIComponent(id)}/recent-changes`,
  'access-package': (id) => `/api/access-package/${encodeURIComponent(id)}/recent-changes`,
  'identity':       (id) => `/api/identities/${encodeURIComponent(id)}/recent-changes`,
};

export default function useRecentChanges(entityKind, entityId, authFetch, { sinceDays = 30, limit = 50 } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const urlFn = ENDPOINT[entityKind];
    if (!urlFn || !entityId) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    const url = `${urlFn(entityId)}?sinceDays=${sinceDays}&limit=${limit}`;
    authFetch(url)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled) setData(d || { events: [], addedCount: 0, removedCount: 0, sinceDays }); })
      .catch(() => { if (!cancelled) setData({ events: [], addedCount: 0, removedCount: 0, sinceDays }); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [entityKind, entityId, authFetch, sinceDays, limit]);

  const derived = useMemo(() => {
    if (!data) return { events: [], addedCount: 0, removedCount: 0, added: [], removed: [], addedIds: new Set(), sinceDays };
    const added = data.events.filter(e => e.operation === 'added');
    const removed = data.events.filter(e => e.operation === 'removed');
    const addedIds = new Set(added.map(e => e.counterpartyId).filter(Boolean));
    return {
      events: data.events,
      addedCount: data.addedCount || added.length,
      removedCount: data.removedCount || removed.length,
      added,
      removed,
      addedIds,
      sinceDays: data.sinceDays || sinceDays,
    };
  }, [data, sinceDays]);

  return { ...derived, loading };
}
