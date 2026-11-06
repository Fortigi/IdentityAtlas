import { useEffect, useRef, useState } from 'react';
import { useFetch } from '@ui/hooks/useFetch';
import { useDebouncedValue } from '@ui/hooks/useDebouncedValue';

// One page of a unit's People overview: GET /api/contexts/:id/people with
// ?filter, ?search, ?limit and ?offset. The filter belongs to the page (the
// attention line's "to decide" sets it too); the search and the page are this
// hook's, and a new filter or search starts again at the first page. Read again
// when `version` changes (a decision, a role, a member edit elsewhere on the
// page) — the first read is useFetch's own.

export const PEOPLE_PAGE_SIZE = 100;
export const SEARCH_DELAY_MS = 250;

const EMPTY = { data: [], total: 0, counts: { current: 0, former: 0, all: 0, decide: 0 }, linkedResources: 0 };

export function peopleUrl(contextId, { filter, search, page }) {
  const params = new URLSearchParams({ filter, limit: String(PEOPLE_PAGE_SIZE), offset: String(page * PEOPLE_PAGE_SIZE) });
  if (search) params.set('search', search);
  return `/api/contexts/${contextId}/people?${params}`;
}

export function usePeople(authFetch, contextId, { filter = 'current', version = 0, enabled = true } = {}) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const typed = useDebouncedValue(search.trim(), SEARCH_DELAY_MS);

  // A new filter or search starts at the first page — compared during render, so no setState runs in an effect.
  const sig = `${filter}|${typed}`;
  const [seenSig, setSeenSig] = useState(sig);
  if (sig !== seenSig) {
    setSeenSig(sig);
    setPage(0);
  }

  const result = useFetch(enabled ? peopleUrl(contextId, { filter, search: typed, page: sig === seenSig ? page : 0 }) : null, { authFetch, enabled, initialData: EMPTY });
  const reload = result.reload;
  const seenVersion = useRef(version);
  useEffect(() => {
    if (seenVersion.current === version) return;
    seenVersion.current = version;
    reload();
  }, [version, reload]);

  const data = result.data || EMPTY;
  return {
    people: data.data || [], total: data.total || 0, counts: data.counts || EMPTY.counts, linkedResources: data.linkedResources || 0,
    loading: result.loading, error: result.error, reload,
    search, setSearch, page, setPage,
    pages: Math.max(1, Math.ceil((data.total || 0) / PEOPLE_PAGE_SIZE)),
  };
}
