// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
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

function setup({ handler, baseFilters } = {}) {
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
  const { result } = renderHook(
    () =>
      useEntityPage({
        authFetch: af,
        entityType: 'user',
        listEndpoint: LIST,
        columnsEndpoint: COLUMNS,
        tagFilterKey: '__userTag',
        baseFilters,
      }),
    { wrapper }
  );
  return { af, result };
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

  it('toggleSort cycles direction and sortedItems reflects the sort', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.toggleSort('displayName'));
    expect(result.current.sortCol).toBe('displayName');
    expect(result.current.sortDir).toBe('asc');
    expect(result.current.sortedItems.map((i) => i.id)).toEqual(['2', '1']); // alice < Bob

    act(() => result.current.toggleSort('displayName'));
    expect(result.current.sortDir).toBe('desc');
    expect(result.current.sortedItems.map((i) => i.id)).toEqual(['1', '2']);
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

  it('activeTagFilter reflects a filter on the tag filter key', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.addFilter('__userTag', 'VIP'));
    await waitFor(() => expect(result.current.activeTagFilter).toBe('VIP'));
  });
});
