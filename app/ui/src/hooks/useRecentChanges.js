import { useMemo } from 'react';
import { useFetch } from '@ui/hooks/useFetch';

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
  const urlFn = ENDPOINT[entityKind];
  const url = (urlFn && entityId)
    ? `${urlFn(entityId)}?sinceDays=${sinceDays}&limit=${limit}`
    : null;
  // A non-ok/failed fetch leaves `data` null; the derived defaults below render
  // an empty change set (matches the previous fallback object).
  const { data, loading } = useFetch(url, { authFetch });

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
