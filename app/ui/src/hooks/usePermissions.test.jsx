// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { usePermissions } from '@ui/hooks/usePermissions';
import { makeWrapper, makeAuthFetch, jsonResponse, renderHook, waitFor } from '@ui/test-utils/renderWithProviders';

describe('usePermissions', () => {
  it('fetches permissions + columns + tags and exposes the rows', async () => {
    const authFetch = makeAuthFetch({
      '/api/permissions': {
        data: [{ userId: 'u1' }, { userId: 'u2' }, { userId: 'u3' }],
        totalUsers: 42,
        managedByPackages: ['ap1'],
      },
      '/api/access-package-groups': [{ resourceId: 'g1' }],
      '/api/user-columns?schema=true': [{ column: 'department' }],
      '/api/resource-columns?schema=true': [{ column: 'displayName' }],
      '/api/user-columns': [{ column: 'department' }, { column: 'city' }],
      '/api/resource-columns': [{ column: 'displayName' }],
      '/api/entity-tags?entityType=resource': [
        { entityId: 'abc', tagId: 't1', tagName: 'Tag', tagColor: '#fff' },
      ],
    });

    const { result } = renderHook(() => usePermissions(25, [], []), {
      wrapper: makeWrapper({ auth: { authFetch } }).wrapper,
    });

    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.data.length).toBe(3));
    expect(result.current.totalUsers).toBe(42);
    expect(result.current.managedByPackages).toEqual(['ap1']);
    expect(result.current.loading).toBe(false);

    await waitFor(() => expect(result.current.accessPackageGroups.length).toBe(1));
    await waitFor(() => expect(result.current.userColumns).not.toBe(null));
    await waitFor(() => expect(result.current.groupTagMap).not.toBe(null));
    expect(result.current.groupTagMap.get('ABC')).toEqual([
      { id: 't1', name: 'Tag', color: '#fff' },
    ]);
  });

  it('puts recognized column filters into the permissions query string', async () => {
    const authFetch = makeAuthFetch({
      '/api/permissions': { data: [], totalUsers: 0 },
      '/api/access-package-groups': [],
      '/api/user-columns?schema=true': [{ column: 'department' }],
      '/api/resource-columns?schema=true': [],
      '/api/user-columns': [{ column: 'department' }],
      '/api/resource-columns': [],
      '/api/entity-tags': [],
    });

    const activeFilters = [
      { field: 'department', value: 'IT' },
      // Unknown field — should be dropped from the server filters.
      { field: 'membershipType', value: 'Direct' },
    ];
    const { result } = renderHook(() => usePermissions(10, activeFilters, ['ctx1']), {
      wrapper: makeWrapper({ auth: { authFetch } }).wrapper,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    await waitFor(() => {
      const permCall = authFetch.mock.calls
        .map((c) => String(c[0]))
        .find((u) => u.includes('/api/permissions') && u.includes('filters='));
      expect(permCall).toBeDefined();
    });

    const permUrl = authFetch.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes('/api/permissions'))
      .pop();
    const qs = new URLSearchParams(permUrl.split('?')[1]);
    expect(qs.get('userLimit')).toBe('10');
    const filters = JSON.parse(qs.get('filters'));
    expect(filters).toEqual({ department: 'IT' });
    expect(qs.get('contextFilters')).toBe(JSON.stringify(['ctx1']));
  });

  it('records the error message when the permissions request fails', async () => {
    const authFetch = makeAuthFetch({
      '/api/permissions': jsonResponse({ error: 'denied' }, { ok: false, status: 403 }),
      '/api/access-package-groups': [],
      '/api/user-columns?schema=true': [],
      '/api/resource-columns?schema=true': [],
      '/api/user-columns': [],
      '/api/resource-columns': [],
      '/api/entity-tags': [],
    });

    const { result } = renderHook(() => usePermissions(25, [], []), {
      wrapper: makeWrapper({ auth: { authFetch } }).wrapper,
    });

    await waitFor(() => expect(result.current.error).toBe('denied'));
    expect(result.current.loading).toBe(false);
  });

  it('forceRefresh triggers another permissions fetch', async () => {
    const authFetch = makeAuthFetch({
      '/api/permissions': { data: [], totalUsers: 0 },
      '/api/access-package-groups': [],
      '/api/user-columns?schema=true': [],
      '/api/resource-columns?schema=true': [],
      '/api/user-columns': [],
      '/api/resource-columns': [],
      '/api/entity-tags': [],
    });

    const { result } = renderHook(() => usePermissions(25, [], []), {
      wrapper: makeWrapper({ auth: { authFetch } }).wrapper,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    const before = authFetch.mock.calls.filter((c) => String(c[0]).includes('/api/permissions')).length;

    result.current.forceRefresh();

    await waitFor(() => {
      const after = authFetch.mock.calls.filter((c) => String(c[0]).includes('/api/permissions')).length;
      expect(after).toBeGreaterThan(before);
    });
  });
});
