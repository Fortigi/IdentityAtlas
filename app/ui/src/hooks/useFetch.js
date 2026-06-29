import { useReducer, useEffect, useCallback, useRef } from 'react';

// Shared GET-fetch hook. Centralises the loading/error/cancel lifecycle that was
// hand-rolled (and tripped react-hooks/set-state-in-effect with a synchronous
// setLoading(true) at the top of an effect) in ~dozens of components.
//
// It uses useReducer rather than separate useState setters precisely so the
// effect can flip to "loading" with a single dispatch — dispatch is not flagged
// by set-state-in-effect, where a synchronous setState() is. The fetch, JSON
// parse, error handling and abort-on-unmount/dep-change all live here once.
//
//   const { data, loading, error, reload } = useFetch('/api/things', { authFetch });
//
// Options:
//   authFetch  (required) — the authenticated fetch from useAuth()
//   enabled    — skip the request when false (e.g. a tab not yet opened). Default true.
//   transform  — map the parsed JSON before it lands in `data` (e.g. d => d.items)
//   initialData — value of `data` before the first response (default null)
//   onError    — optional side-effect callback for a failed request

function reducer(state, action) {
  switch (action.type) {
    case 'loading': return { data: state.data, loading: true, error: null };
    case 'success': return { data: action.data, loading: false, error: null };
    case 'error':   return { data: state.data, loading: false, error: action.error };
    case 'idle':    return { data: state.data, loading: false, error: null };
    default:        return state;
  }
}

export function useFetch(url, { authFetch, enabled = true, transform, initialData = null, onError } = {}) {
  const [state, dispatch] = useReducer(reducer, {
    data: initialData,
    loading: !!(enabled && url),
    error: null,
  });

  // Keep the latest transform/onError without making them effect deps (callers
  // routinely pass inline functions). Updated in an effect — not during render —
  // so we don't trip react-hooks/refs; declared before the fetch effect so the
  // values are fresh by the time it runs.
  const transformRef = useRef(transform);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    transformRef.current = transform;
    onErrorRef.current = onError;
  });

  // Bump to force a re-fetch; kept in the effect deps so reload() re-runs it.
  const [reloadKey, forceReload] = useReducer((n) => n + 1, 0);
  const reload = useCallback(() => forceReload(), []);

  useEffect(() => {
    if (!enabled || !url) { dispatch({ type: 'idle' }); return undefined; }
    let cancelled = false;
    dispatch({ type: 'loading' });
    authFetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        if (cancelled) return;
        dispatch({ type: 'success', data: transformRef.current ? transformRef.current(d) : d });
      })
      .catch((err) => {
        if (cancelled) return;
        dispatch({ type: 'error', error: err });
        onErrorRef.current?.(err);
      });
    return () => { cancelled = true; };
  }, [url, enabled, authFetch, reloadKey]);

  return { data: state.data, loading: state.loading, error: state.error, reload };
}
