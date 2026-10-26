import { useCallback, useEffect, useReducer, useState } from 'react';
import { profileFor } from './profiles/profiles';

// A context's detail (GET /api/contexts/:id) and its risk score
// (GET /api/risk-scores/contexts/:id, optional), for its detail page. The
// detail is re-read when `refreshKey` changes or fetchDetail() is called, and
// handed to onCacheData (the app shell names the tab from it).

export function useContextDetail(authFetch, contextId, refreshKey, onCacheData) {
  // loading/error are flipped synchronously inside the fetch effect; reducer
  // dispatches keep that clear of set-state-in-effect.
  const [loading, setLoading] = useReducer((_, v) => v, true);
  const [error, setError] = useReducer((_, v) => v, null);
  const [detail, setDetail] = useState(null);
  const [riskData, setRiskData] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await authFetch(`/api/risk-scores/contexts/${contextId}`);
        if (res.ok) setRiskData(await res.json());
      } catch { /* risk data optional */ }
    })();
  }, [authFetch, contextId]);

  // `quiet`: re-read without the loading state, so the page stays as it is
  // (open sections, a transcript panel) — after a claim decision that changed
  // the context: an alias, a property, the description.
  const fetchDetail = useCallback(({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    setError(null);
    return authFetch(`/api/contexts/${contextId}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setDetail(data);
        if (onCacheData) onCacheData(contextId, 'context', data);
      })
      .catch((err) => {
        console.error('Failed to load context detail:', err);
        if (!quiet) setError(err.message || 'Failed to load context details');
      })
      .finally(() => { if (!quiet) setLoading(false); });
  }, [authFetch, contextId, onCacheData]);

  useEffect(() => { fetchDetail(); }, [fetchDetail, refreshKey]);

  const refreshDetail = useCallback(() => fetchDetail({ quiet: true }), [fetchDetail]);

  return { detail, loading, error, fetchDetail, refreshDetail, riskData };
}

// What the page offers this reader for this context:
//   editable  Edit and Add sub-unit — the analyst, on a context created here
//             or derived (an imported one is refreshed by its source, so
//             edits would not last)
//   membersEditable  "Edit members" — the analyst, on a context created here
//             only: there adding AND removing both last. A derived or imported
//             context's members come back on its next refresh, so editing
//             them would only ever half work.
export function contextPageView({ analyst, attrs }) {
  if (!analyst) return { editable: false, membersEditable: false };
  return {
    editable: attrs.variant === 'manual' || attrs.variant === 'generated',
    membersEditable: attrs.variant === 'manual',
  };
}

const PEOPLE_TARGETS = new Set(['Principal', 'Identity']);

/**
 * Whether the page lists the members as their source does (GET …/members): every
 * context but a unit or an application of people, whose People overview shows
 * them (GET …/people). False until the context is loaded.
 */
export function listsMembers(attrs) {
  if (!attrs) return false;
  return !(profileFor(attrs.contextCategory) && PEOPLE_TARGETS.has(attrs.targetType));
}
