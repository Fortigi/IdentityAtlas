// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  renderHook,
  act,
  waitFor,
  makeWrapper,
  makeAuthFetch,
} from '@ui/test-utils/renderWithProviders';
import useEntityPage from '@ui/hooks/useEntityPage';

const LIST = '/api/users';
const COLUMNS = '/api/users/columns';

beforeEach(() => sessionStorage.clear());

function setup(entityType = 'user') {
  const af = makeAuthFetch({
    [COLUMNS]: [{ column: 'department', values: ['Sales'] }],
    [LIST]: { data: [{ id: '1', displayName: 'Bob' }], total: 1 },
    '/api/tags': [],
  });
  const { wrapper } = makeWrapper({ auth: { authFetch: af } });
  const { result } = renderHook(
    () => useEntityPage({ authFetch: af, entityType, listEndpoint: LIST, columnsEndpoint: COLUMNS, tagFilterKey: '__userTag' }),
    { wrapper },
  );
  return { af, result };
}

function lastListUrl(af) {
  const calls = af.mock.calls.map((c) => String(c[0]));
  return [...calls].reverse().find((u) => u.startsWith(LIST + '?'));
}

describe('useEntityPage — relationship filters (#840)', () => {
  it('maps entityType to a relationship target (user → Principal)', async () => {
    const { result } = setup('user');
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.relTargetType).toBe('Principal');
  });

  it('gates out entities with no relationship target (identity → null)', async () => {
    const { result } = setup('identity');
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.relTargetType).toBeNull();
  });

  it('serializes relFilters into the list request and flags hasAnyFilter', async () => {
    const { af, result } = setup('user');
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.addRelFilter({ edge: 'principal.sponsor', op: 'absent' }));
    await waitFor(() => {
      const url = lastListUrl(af);
      expect(url).toContain('relFilters=');
      expect(decodeURIComponent(url)).toContain('"edge":"principal.sponsor"');
    });
    expect(result.current.hasAnyFilter).toBe(true);
    expect(result.current.relFilters).toEqual([{ edge: 'principal.sponsor', op: 'absent' }]);
  });

  it('replaces a condition when the same edge is re-added, and removes it', async () => {
    const { af, result } = setup('user');
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.addRelFilter({ edge: 'principal.owner', op: 'lt', n: 2 }));
    act(() => result.current.addRelFilter({ edge: 'principal.owner', op: 'absent' }));
    expect(result.current.relFilters).toEqual([{ edge: 'principal.owner', op: 'absent' }]);

    act(() => result.current.removeRelFilter('principal.owner'));
    await waitFor(() => expect(result.current.relFilters).toEqual([]));
    const url = lastListUrl(af);
    expect(url).not.toContain('relFilters=');
  });

  it('clearAllFilters clears relationship filters too', async () => {
    const { result } = setup('user');
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.addRelFilter({ edge: 'principal.sponsor', op: 'exists' }));
    act(() => result.current.clearAllFilters());
    expect(result.current.relFilters).toEqual([]);
  });
});
