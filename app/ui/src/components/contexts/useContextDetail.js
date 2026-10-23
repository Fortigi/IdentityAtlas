import { useCallback, useEffect, useReducer, useState } from 'react';

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

  const fetchDetail = useCallback(() => {
    setLoading(true);
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
        setError(err.message || 'Failed to load context details');
      })
      .finally(() => setLoading(false));
  }, [authFetch, contextId, onCacheData]);

  useEffect(() => { fetchDetail(); }, [fetchDetail, refreshKey]);

  return { detail, loading, error, fetchDetail, riskData };
}

// What the page offers this reader for this context:
//   editable  Edit and Add sub-unit — the analyst, on a context created here
//             or derived (an imported one is refreshed by its source, so
//             edits would not last)
//   membersEditable  "Edit members" — the analyst, on a context created here
//             only: there adding AND removing both last. A derived or imported
//             context's members come back on its next refresh, so editing
//             them would only ever half work.
//   tabs      the analyst's tabs (Members, Timeline, Risk when scored);
//             null for a business reader, who gets the members only
//   shownTab  the tab whose panel renders
export function contextPageView({ analyst, attrs, hasRisk, memberTotal, activeTab }) {
  if (!analyst) return { editable: false, membersEditable: false, tabs: null, shownTab: 'members' };
  return {
    editable: attrs.variant === 'manual' || attrs.variant === 'generated',
    membersEditable: attrs.variant === 'manual',
    tabs: [
      { key: 'members', label: 'Members', count: memberTotal },
      { key: 'timeline', label: 'Timeline' },
      hasRisk && { key: 'risk', label: 'Risk' },
    ],
    shownTab: activeTab,
  };
}
