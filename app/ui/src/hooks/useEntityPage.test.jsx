// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  renderHook,
  act,
  waitFor,
  makeWrapper,
  makeAuthFetch,
  jsonResponse,
} from '@ui/test-utils/renderWithProviders';
import useEntityPage from '@ui/hooks/useEntityPage';

const LIST = '/api/users';
const COLUMNS = '/api/users/columns';

// useEntityPage now persists search/filters/sort to sessionStorage (issue #192),
// so each test must start from a clean slate to stay isolated.
beforeEach(() => sessionStorage.clear());

function setup({ handler, baseFilters, entityType = 'user' } = {}) {
  const af = makeAuthFetch(
    handler || {
      [COLUMNS]: [
        { column: 'department', values: ['Sales', 'Eng'] },
        { column: 'ext.costCenter', values: ['CC1'] },
        { column: 'tooMany', values: Array.from({ length: 600 }, (_, i) => `v${i}`) },
        { column: 'empty', values: [] },
      ],
      [LIST]: { data: [{ id: '1', displayName: 'Bob' }, { id: '2', displayName: 'alice' }], total: 250 },
      '/api/tags': [{ id: 't1', name: 'VIP' }],
    }
  );
  const { wrapper } = makeWrapper({ auth: { authFetch: af } });
  const { result, unmount } = renderHook(
    () =>
      useEntityPage({
        authFetch: af,
        entityType,
        listEndpoint: LIST,
        columnsEndpoint: COLUMNS,
        tagFilterKey: '__userTag',
        baseFilters,
      }),
    { wrapper }
  );
  return { af, result, unmount };
}

// Pull the last list request URL out of the mock's call list.
function lastListUrl(af) {
  const calls = af.mock.calls.map((c) => String(c[0]));
  return [...calls].reverse().find((u) => u.startsWith(LIST + '?'));
}

describe('useEntityPage', () => {
  it('fetches items, columns and tags on mount and exposes derived state', async () => {
    const { af, result } = setup();
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.items).toEqual([
      { id: '1', displayName: 'Bob' },
      { id: '2', displayName: 'alice' },
    ]);
    expect(result.current.total).toBe(250);
    expect(result.current.totalPages).toBe(3); // ceil(250/100)
    expect(result.current.PAGE_SIZE).toBe(100);
    expect(result.current.tags).toEqual([{ id: 't1', name: 'VIP' }]);

    await waitFor(() => expect(result.current.columnsLoading).toBe(false));
    expect(af).toHaveBeenCalledWith(COLUMNS);
    expect(af).toHaveBeenCalledWith('/api/tags?entityType=user');

    const url = lastListUrl(af);
    expect(url).toContain('limit=100');
    expect(url).toContain('offset=0');
  });

  it('debounced search flows into the list query params', async () => {
    const { af, result } = setup();
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.setSearch('foo'));
    await waitFor(() => {
      const url = lastListUrl(af);
      expect(url).toContain('search=foo');
    });
    expect(result.current.debouncedSearch).toBe('foo');
    expect(result.current.hasAnyFilter).toBeTruthy();
  });

  it('paginates via offset = page * PAGE_SIZE', async () => {
    const { af, result } = setup();
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.setPage(2));
    await waitFor(() => {
      const url = lastListUrl(af);
      expect(url).toContain('offset=200');
    });
  });

  it('keeps the known total when a later page returns total:null (no Next-button crash)', async () => {
    // The list endpoints only send `total` on page 1; later pages return
    // total:null to skip a redundant COUNT. The hook must not clobber the known
    // total — otherwise the pager/header hit `null.toLocaleString()` on Next.
    const af = makeAuthFetch((url) => {
      const s = String(url);
      if (s.includes(COLUMNS)) return [];
      if (s.includes('/api/tags')) return [];
      if (s.includes(LIST)) {
        const offset = new URLSearchParams(s.split('?')[1] || '').get('offset');
        return offset === '0'
          ? { data: [{ id: '1', displayName: 'Bob' }], total: 250 }
          : { data: [{ id: '2', displayName: 'Al' }], total: null };
      }
      return undefined;
    });
    const { wrapper } = makeWrapper({ auth: { authFetch: af } });
    const { result } = renderHook(
      () =>
        useEntityPage({
          authFetch: af,
          entityType: 'user',
          listEndpoint: LIST,
          columnsEndpoint: COLUMNS,
          tagFilterKey: '__userTag',
        }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.total).toBe(250);

    act(() => result.current.setPage(1));
    await waitFor(() => expect(lastListUrl(af)).toContain('offset=100'));
    await waitFor(() =>
      expect(result.current.items).toEqual([{ id: '2', displayName: 'Al' }])
    );

    // total survives the page change — stays a number, never becomes null.
    expect(result.current.total).toBe(250);
    expect(result.current.totalPages).toBe(3);
  });

  it('includeDeleted adds the query flag', async () => {
    const { af, result } = setup();
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.setIncludeDeleted(true));
    await waitFor(() => {
      const url = lastListUrl(af);
      expect(url).toContain('includeDeleted=true');
    });
  });

  it('addFilter/removeFilter/clearAllFilters drive the filters JSON param', async () => {
    const { af, result } = setup();
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.addFilter('department', 'Sales'));
    await waitFor(() => {
      const url = lastListUrl(af);
      expect(url).toContain('filters=');
      expect(decodeURIComponent(url)).toContain('"department":"Sales"');
    });
    expect(result.current.activeFilters).toEqual([{ field: 'department', value: 'Sales' }]);
    expect(result.current.filtersObj).toEqual({ department: 'Sales' });

    act(() => result.current.removeFilter('department'));
    await waitFor(() => expect(result.current.activeFilters).toEqual([]));

    act(() => result.current.setSearch('x'));
    await waitFor(() => expect(result.current.debouncedSearch).toBe('x'));
    act(() => result.current.clearAllFilters());
    await waitFor(() => expect(result.current.search).toBe(''));
    expect(result.current.activeFilters).toEqual([]);
  });

  it('merges baseFilters under activeFilters, dropping empty base keys', async () => {
    const baseFilters = { principalType: 'Member', dropped: '' };
    const { result } = setup({ baseFilters });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.filtersObj).toEqual({ principalType: 'Member' });

    act(() => result.current.addFilter('principalType', 'Guest'));
    await waitFor(() => expect(result.current.filtersObj).toEqual({ principalType: 'Guest' }));
  });

  it('toggleSelect / toggleSelectAll manage the selection set', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.toggleSelect('1'));
    expect(result.current.selected.has('1')).toBe(true);

    act(() => result.current.toggleSelect('1'));
    expect(result.current.selected.has('1')).toBe(false);

    act(() => result.current.toggleSelectAll());
    expect(result.current.selected.size).toBe(2);
    expect(result.current.allOnPageSelected).toBe(true);

    act(() => result.current.toggleSelectAll());
    expect(result.current.selected.size).toBe(0);
  });

  it('toggleSort pushes sort+dir to the server and renders rows in the returned order', async () => {
    const { af, result } = setup();
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Without a sort column, no sort/dir params are sent.
    expect(lastListUrl(af)).not.toContain('sort=');

    act(() => result.current.toggleSort('displayName'));
    expect(result.current.sortCol).toBe('displayName');
    expect(result.current.sortDir).toBe('asc');
    await waitFor(() => {
      const url = lastListUrl(af);
      expect(url).toContain('sort=displayName');
      expect(url).toContain('dir=asc');
    });

    act(() => result.current.toggleSort('displayName'));
    expect(result.current.sortDir).toBe('desc');
    await waitFor(() => expect(lastListUrl(af)).toContain('dir=desc'));

    // Rows are shown in the order the server returned them — no client re-sort.
    expect(result.current.sortedItems).toBe(result.current.items);
  });

  it('resets to the first page when the sort changes', async () => {
    const { af, result } = setup();
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.setPage(2));
    await waitFor(() => expect(lastListUrl(af)).toContain('offset=200'));

    act(() => result.current.toggleSort('displayName'));
    await waitFor(() => {
      const url = lastListUrl(af);
      expect(url).toContain('sort=displayName');
      expect(url).toContain('offset=0');
    });
    expect(result.current.page).toBe(0);
  });

  it('getFilterFields and getOptionsForField derive from available columns', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.columnsLoading).toBe(false));

    const fields = result.current.getFilterFields({ department: 'Dept' });
    const keys = fields.map((f) => f.key);
    expect(keys).toContain('department');
    expect(keys).toContain('ext.costCenter');
    // tooMany (>500 values) and empty (0 values) are filtered out
    expect(keys).not.toContain('tooMany');
    expect(keys).not.toContain('empty');

    const dept = fields.find((f) => f.key === 'department');
    expect(dept.label).toBe('Dept'); // explicit label wins
    const ext = fields.find((f) => f.key === 'ext.costCenter');
    expect(ext.label).toContain('(ext)');

    expect(result.current.getOptionsForField('department')).toEqual(['Sales', 'Eng']);
    expect(result.current.getOptionsForField('nope')).toEqual([]);
  });

  it('createTag posts and refreshes tags', async () => {
    const af = makeAuthFetch({
      [COLUMNS]: [],
      [LIST]: { data: [], total: 0 },
      '/api/tags': (url, opts = {}) =>
        opts.method === 'POST' ? jsonResponse({ id: 'new' }) : [{ id: 't1', name: 'VIP' }],
    });
    const { wrapper } = makeWrapper({ auth: { authFetch: af } });
    const { result } = renderHook(
      () =>
        useEntityPage({
          authFetch: af,
          entityType: 'user',
          listEndpoint: LIST,
          columnsEndpoint: COLUMNS,
          tagFilterKey: '__userTag',
        }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.setNewTagName('NewTag'));
    await act(async () => {
      await result.current.createTag();
    });

    expect(af).toHaveBeenCalledWith(
      '/api/tags',
      expect.objectContaining({ method: 'POST' })
    );
    expect(result.current.showCreateTag).toBe(false);
    expect(result.current.newTagName).toBe('');
  });

  it('assignTag posts entity ids for the selected set', async () => {
    const af = makeAuthFetch({
      [COLUMNS]: [],
      [LIST]: { data: [{ id: '1' }, { id: '2' }], total: 2 },
      '/assign': jsonResponse({ ok: true }),
      '/api/tags': [],
    });
    const { wrapper } = makeWrapper({ auth: { authFetch: af } });
    const { result } = renderHook(
      () =>
        useEntityPage({
          authFetch: af,
          entityType: 'user',
          listEndpoint: LIST,
          columnsEndpoint: COLUMNS,
          tagFilterKey: '__userTag',
        }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.toggleSelect('1'));
    act(() => result.current.setActionTag('t1'));
    await act(async () => {
      await result.current.assignTag();
    });

    expect(af).toHaveBeenCalledWith(
      '/api/tags/t1/assign',
      expect.objectContaining({ method: 'POST' })
    );
    const call = af.mock.calls.find((c) => String(c[0]).endsWith('/assign'));
    expect(JSON.parse(call[1].body)).toEqual({ entityIds: ['1'] });
    expect(result.current.actionTag).toBe('');
  });

  it('refetches column discovery after a tag is assigned (issue #943)', async () => {
    // #943: the filter dropdown's options come from the column-discovery
    // snapshot. A tag only enters that snapshot once it HAS assignments, so
    // assigning must invalidate the columns — otherwise a tag created and
    // assigned in this session is absent from the options and the active
    // filter pill renders the wrong (alphabetically first) tag name.
    const { af, result } = setup();
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(result.current.columnsLoading).toBe(false));

    const columnsCalls = () =>
      af.mock.calls.filter((c) => String(c[0]).startsWith(COLUMNS)).length;
    const before = columnsCalls();

    act(() => result.current.toggleSelect('1'));
    act(() => result.current.setActionTag('t1'));
    await act(async () => {
      await result.current.assignTag();
    });

    await waitFor(() => expect(columnsCalls()).toBe(before + 1));
  });

  it('activeTagFilter reflects a filter on the tag filter key', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.addFilter('__userTag', 'VIP'));
    await waitFor(() => expect(result.current.activeTagFilter).toBe('VIP'));
  });

  it('persists search, filters and sort across an unmount and restores them on remount (#192)', async () => {
    // Apply a search + filter + sort, then unmount the page (as happens when a
    // result is opened in a detail tab).
    const first = setup();
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    act(() => first.result.current.setSearch('alice'));
    act(() => first.result.current.addFilter('department', 'Sales'));
    act(() => first.result.current.setIncludeDeleted(true));
    act(() => first.result.current.toggleSort('displayName'));
    await waitFor(() => expect(first.result.current.debouncedSearch).toBe('alice'));
    first.unmount();

    // Remount a fresh hook for the same entity type — state comes back.
    const second = setup();
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    expect(second.result.current.search).toBe('alice');
    expect(second.result.current.activeFilters).toEqual([{ field: 'department', value: 'Sales' }]);
    expect(second.result.current.includeDeleted).toBe(true);
    expect(second.result.current.sortCol).toBe('displayName');

    // ...and the restored search drives the list query on remount.
    await waitFor(() => {
      const url = lastListUrl(second.af);
      expect(url).toContain('search=alice');
      expect(decodeURIComponent(url)).toContain('"department":"Sales"');
    });
  });

  it('keeps persisted state isolated per entity type', async () => {
    const users = setup({ entityType: 'user' });
    await waitFor(() => expect(users.result.current.loading).toBe(false));
    act(() => users.result.current.setSearch('only-users'));
    await waitFor(() => expect(users.result.current.debouncedSearch).toBe('only-users'));
    users.unmount();

    // A different entity type must not inherit the user-page search.
    const groups = setup({ entityType: 'group' });
    await waitFor(() => expect(groups.result.current.loading).toBe(false));
    expect(groups.result.current.search).toBe('');
  });
});

// ── When the sidecar fetches fail ───────────────────────────────────────────
// Columns and tags are loaded alongside the list, and each has the same two-step
// guard: `res.ok ? res.json() : null`, then `if (data) setX(data)`. Neither
// failure arm was reachable from this file -- only a mount test elsewhere in the
// suite happened to drive them, which is a poor place for the contract to live
// and left these mutants unkilled here.
//
// What must NOT happen is the interesting part: a failed columns fetch must leave
// the previous columns alone rather than blanking them, because the filter bar is
// built from that list. Overwriting it with null or [] silently removes every
// filter the user could apply, and an empty filter bar looks like a page with
// nothing to filter on rather than a page whose request failed.
describe('useEntityPage sidecar failures', () => {
  // KEY ORDER MATTERS: makeAuthFetch matches by substring, and the columns URL
  // ('/api/users/columns') contains the list URL ('/api/users'). List-first would
  // answer the columns request with the list payload -- an object where an array
  // is expected, which fails deep inside getFilterFields rather than at the mock.
  const listOnly = (extra = {}) => ({
    ...extra,
    [LIST]: { data: [{ id: '1', displayName: 'Bob' }], total: 1 },
  });

  it('keeps the list usable when the columns request fails', async () => {
    const { result } = setup({
      handler: listOnly({
        [COLUMNS]: jsonResponse({ error: 'nope' }, { ok: false, status: 500 }),
        '/api/tags': [{ id: 't1', name: 'VIP' }],
      }),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    // The rows still arrive — one failed sidecar does not take the page down.
    expect(result.current.items).toEqual([{ id: '1', displayName: 'Bob' }]);
    // ...and the loading flag still settles, or the filter bar spins forever.
    await waitFor(() => expect(result.current.columnsLoading).toBe(false));
    // Tags are unaffected: the two fetches fail independently.
    expect(result.current.tags).toEqual([{ id: 't1', name: 'VIP' }]);
  });

  it('keeps the list usable when the tags request fails', async () => {
    const { result } = setup({
      handler: listOnly({
        [COLUMNS]: [{ column: 'department', values: ['Sales'] }],
        '/api/tags': jsonResponse({ error: 'nope' }, { ok: false, status: 503 }),
      }),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items).toEqual([{ id: '1', displayName: 'Bob' }]);
    // Columns are unaffected — again, independent failures. Asserted through
    // getOptionsForField rather than getFilterFields: the latter dereferences the
    // `fieldLabels` prop with no default, so it throws for any caller that omits
    // one. Worth knowing, but not this test's subject.
    await waitFor(() => expect(result.current.columnsLoading).toBe(false));
    expect(result.current.getOptionsForField('department')).toEqual(['Sales']);
  });

  it('leaves both sidecars at their defaults when both fail', async () => {
    const { result } = setup({
      handler: listOnly({
        [COLUMNS]: jsonResponse({ error: 'nope' }, { ok: false, status: 500 }),
        '/api/tags': jsonResponse({ error: 'nope' }, { ok: false, status: 500 }),
      }),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(result.current.columnsLoading).toBe(false));
    // Both stay empty rather than becoming null: every consumer maps over them.
    expect(result.current.tags).toEqual([]);
    expect(result.current.getOptionsForField('department')).toEqual([]);
    expect(result.current.items).toEqual([{ id: '1', displayName: 'Bob' }]);
  });
});
