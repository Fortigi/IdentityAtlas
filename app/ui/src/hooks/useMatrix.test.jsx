// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { useMatrix } from '@ui/hooks/useMatrix';
import { makeWrapper, makeAuthFetch, jsonResponse, renderHook, waitFor } from '@ui/test-utils/renderWithProviders';

describe('useMatrix', () => {
  it('fetches reference data on mount and stays idle without a filter', async () => {
    const authFetch = makeAuthFetch({
      '/api/access-package-groups': [
        { resourceId: 'g1', displayName: 'Group One', description: 'desc' },
      ],
      '/api/entity-tags?entityType=resource': [
        { entityId: 'abc', tagId: 't1', tagName: 'Tag', tagColor: '#fff' },
      ],
      '/api/user-columns': [{ column: 'department' }],
      '/api/admin/dashboard-stats': { hasData: true },
      '/api/matrix/default-filter': { conditions: [] },
    });

    const { result } = renderHook(() => useMatrix(null), {
      wrapper: makeWrapper({ auth: { authFetch } }).wrapper,
    });

    // No filter → no matrix data fetch, loading stays false, data empty.
    expect(result.current.data).toEqual([]);
    expect(result.current.loading).toBe(false);

    await waitFor(() => expect(result.current.hasData).toBe(true));
    await waitFor(() => expect(result.current.defaultFilter).not.toBe(undefined));
    expect(result.current.defaultFilter).toEqual({ conditions: [] });

    // Reference data resolved.
    await waitFor(() => expect(result.current.accessPackageGroups.length).toBe(1));
    // Alias mapping: displayName → resourceDisplayName.
    expect(result.current.accessPackageGroups[0].resourceDisplayName).toBe('Group One');
    expect(result.current.accessPackageGroups[0].resourceDescription).toBe('desc');
    await waitFor(() => expect(result.current.groupTagMap).not.toBe(null));
    expect(result.current.groupTagMap.get('ABC')).toEqual([
      { id: 't1', name: 'Tag', color: '#fff' },
    ]);
    await waitFor(() => expect(result.current.userColumns).not.toBe(null));

    // Never POSTed to matrix/data without a filter.
    const matrixCall = authFetch.mock.calls.find((c) => String(c[0]).includes('/api/matrix/data'));
    expect(matrixCall).toBeUndefined();
  });

  it('POSTs the filter to /api/matrix/data and exposes returned rows + counts', async () => {
    const authFetch = makeAuthFetch({
      '/api/matrix/data': {
        data: [{ id: 'u1' }, { id: 'u2' }],
        managedByPackages: ['ap1'],
        resourceContexts: [{ resourceId: 'r1', contexts: [{ id: 'c1', displayName: 'Finance', contextType: 'Tag' }] }],
        rowType: 'principal',
        subjectCount: 2,
        subjectTotal: 10,
        resourceCount: 3,
        resourceTotal: 5,
        assignmentCount: 7,
      },
      '/api/access-package-groups': [],
      '/api/entity-tags': [],
      '/api/user-columns': [],
      '/api/admin/dashboard-stats': { hasData: true },
      '/api/matrix/default-filter': null,
    });

    const filter = { conditions: [{ field: 'department', value: 'IT' }] };
    const { result } = renderHook(() => useMatrix(filter), {
      wrapper: makeWrapper({ auth: { authFetch } }).wrapper,
    });

    await waitFor(() => expect(result.current.data.length).toBe(2));
    expect(result.current.rowType).toBe('principal');
    expect(result.current.managedByPackages).toEqual(['ap1']);
    expect(result.current.resourceContexts).toEqual([
      { resourceId: 'r1', contexts: [{ id: 'c1', displayName: 'Finance', contextType: 'Tag' }] },
    ]);
    expect(result.current.counts.assignmentCount).toBe(7);
    expect(result.current.totalUsers).toBe(10);
    expect(result.current.loading).toBe(false);

    const matrixCall = authFetch.mock.calls.find((c) => String(c[0]).includes('/api/matrix/data'));
    expect(matrixCall).toBeDefined();
    expect(matrixCall[1].method).toBe('POST');
    // Body wraps the bare filter under a `filter` key.
    const parsed = JSON.parse(matrixCall[1].body);
    expect(parsed.filter).toEqual(filter);
  });

  it('populates rollup state when the response is a roll-up payload', async () => {
    const authFetch = makeAuthFetch({
      '/api/matrix/data': {
        rollup: 'department',
        resources: [{ resourceId: 'r1' }],
        groupValues: ['IT', 'HR'],
        counts: [{ resourceId: 'r1', groupValue: 'IT', directCount: 4 }],
      },
      '/api/access-package-groups': [],
      '/api/entity-tags': [],
      '/api/user-columns': [],
      '/api/admin/dashboard-stats': { hasData: false },
      '/api/matrix/default-filter': null,
    });

    const { result } = renderHook(() => useMatrix({ conditions: [{ field: 'x', value: 'y' }] }), {
      wrapper: makeWrapper({ auth: { authFetch } }).wrapper,
    });

    await waitFor(() => expect(result.current.rollup).not.toBe(null));
    expect(result.current.rollup.attribute).toBe('department');
    expect(result.current.rollup.groupValues).toEqual(['IT', 'HR']);
    expect(result.current.data).toEqual([]);
    // Roll-up payloads carry no per-resource rows, so the sidecar clears too.
    expect(result.current.resourceContexts).toEqual([]);
    await waitFor(() => expect(result.current.hasData).toBe(false));
  });

  it('surfaces an error message when the matrix request fails', async () => {
    const authFetch = makeAuthFetch({
      '/api/matrix/data': jsonResponse({ error: 'boom' }, { ok: false, status: 500 }),
      '/api/access-package-groups': [],
      '/api/entity-tags': [],
      '/api/user-columns': [],
      '/api/admin/dashboard-stats': { hasData: true },
      '/api/matrix/default-filter': null,
    });

    const { result } = renderHook(() => useMatrix({ conditions: [{ field: 'x', value: 'y' }] }), {
      wrapper: makeWrapper({ auth: { authFetch } }).wrapper,
    });

    await waitFor(() => expect(result.current.error).toBe('boom'));
    expect(result.current.loading).toBe(false);
  });
});
