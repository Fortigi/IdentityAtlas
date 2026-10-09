import { useEffect, useState } from 'react';
import { asOrgLinked, orgLinkedUrl } from './orgGraphBranch';

// Loads GET /api/org-truth/linked/:targetType/:id for a detail page's graph,
// kept apart from the page's own core fetch so a disabled feature (404/501) or
// an error only drops the Organisation node. Answers are cached per entity
// (per authFetch, so a sign-in change starts fresh); a failure is not cached,
// the next mount asks again.

const cache = new WeakMap();

export function loadOrgLinked(url, authFetch) {
  let byUrl = cache.get(authFetch);
  if (!byUrl) {
    byUrl = new Map();
    cache.set(authFetch, byUrl);
  }
  if (!byUrl.has(url)) {
    const pending = Promise.resolve()
      .then(() => authFetch(url))
      .then(r => (r.ok ? r.json() : null))
      .then(asOrgLinked)
      .catch(() => null)
      .then((data) => {
        if (!data) byUrl.delete(url);
        return data;
      });
    byUrl.set(url, pending);
  }
  return byUrl.get(url);
}

// → the payload, or null while loading / when there is none.
export default function useOrgLinked(entityKind, entityId, authFetch) {
  const url = orgLinkedUrl(entityKind, entityId);
  const [state, setState] = useState({ url: null, data: null });
  useEffect(() => {
    if (!url || !authFetch) return undefined;
    let cancelled = false;
    loadOrgLinked(url, authFetch).then((data) => {
      if (!cancelled) setState({ url, data });
    });
    return () => { cancelled = true; };
  }, [url, authFetch]);
  return state.url === url ? state.data : null;
}
