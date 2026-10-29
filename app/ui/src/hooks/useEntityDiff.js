import { useFetch } from '@ui/hooks/useFetch';

// ─── useEntityDiff ───────────────────────────────────────────────────
// Fetches /api/<kind>/:id/diff?at=<ISO> — the entity as it was at `at` and as
// it is now, as two snapshots for the Diff tab. `enabled` defers the fetch
// until the tab is opened.
//
// Returns { data, loading, error }; data = { at, historySince,
// relationshipsTracked, before, after, omittedUnchanged }.
const ENDPOINT = {
  user:             (id) => `/api/user/${encodeURIComponent(id)}/diff`,
  resource:         (id) => `/api/resources/${encodeURIComponent(id)}/diff`,
  'access-package': (id) => `/api/access-package/${encodeURIComponent(id)}/diff`,
  identity:         (id) => `/api/identities/${encodeURIComponent(id)}/diff`,
  context:          (id) => `/api/contexts/${encodeURIComponent(id)}/diff`,
};

export default function useEntityDiff(entityKind, entityId, authFetch, { at, enabled = true } = {}) {
  const urlFn = ENDPOINT[entityKind];
  const url = (enabled && entityId && urlFn && at)
    ? `${urlFn(entityId)}?at=${encodeURIComponent(at)}`
    : null;
  const { data, loading, error } = useFetch(url, { authFetch });
  return { data, loading, error };
}
