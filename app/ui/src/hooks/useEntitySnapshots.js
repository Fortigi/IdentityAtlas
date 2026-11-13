import { useEffect, useReducer } from 'react';

// ─── useEntitySnapshots ──────────────────────────────────────────────
// Fetches GET /api/<kind>/:id/snapshot for each id, in parallel — the Compare
// view's input. One request per entity on purpose: each is access-checked on
// its own like any other detail read.
//
// Returns { entries, loading }; entries = [{ id, data, error }] in the order of
// `ids`. An entity that failed keeps its place with `error` set, so the other
// columns still show.
const ENDPOINT = {
  user:             (id) => `/api/user/${encodeURIComponent(id)}/snapshot`,
  resource:         (id) => `/api/resources/${encodeURIComponent(id)}/snapshot`,
  'access-package': (id) => `/api/access-package/${encodeURIComponent(id)}/snapshot`,
  identity:         (id) => `/api/identities/${encodeURIComponent(id)}/snapshot`,
};

async function fetchOne(authFetch, url, id) {
  try {
    const r = await authFetch(url);
    if (!r.ok) return { id, data: null, error: new Error(r.status === 404 ? 'Not found' : `HTTP ${r.status}`) };
    return { id, data: await r.json(), error: null };
  } catch (err) {
    return { id, data: null, error: err };
  }
}

const reducer = (_, action) => action;

export default function useEntitySnapshots(entityKind, ids, authFetch) {
  const urlFn = ENDPOINT[entityKind];
  const key = urlFn ? ids.join(',') : '';
  const [state, dispatch] = useReducer(reducer, { key: '', entries: [] });

  useEffect(() => {
    if (!key) return undefined;
    let cancelled = false;
    Promise.all(key.split(',').map(id => fetchOne(authFetch, urlFn(id), id)))
      .then(entries => { if (!cancelled) dispatch({ key, entries }); });
    return () => { cancelled = true; };
  }, [key, urlFn, authFetch]);

  // Results are tagged with the id set they were fetched for: while a new set
  // loads, the old results stay on screen (dimmed by the caller).
  return { entries: state.entries, loading: !!key && state.key !== key };
}
