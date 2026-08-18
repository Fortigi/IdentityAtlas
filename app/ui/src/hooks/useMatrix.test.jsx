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

// ── Response shape ──────────────────────────────────────────────────────────
// Every field of a roll-up or counts payload is read as `body.x || <default>`.
// That single expression carries two failures and both are silent. Lose the
// default and `undefined` reaches the renderer, which draws an empty matrix that
// looks exactly like "this person has no access". Let the default win over a
// present value and real data disappears the same way.
//
// The existing roll-up test asserted two of the seventeen fields, so the other
// fifteen could have defaulted over live data with nothing failing.
describe('useMatrix response mapping', () => {
  const REFERENCE = {
    '/api/access-package-groups': [],
    '/api/entity-tags': [],
    '/api/user-columns': [],
    '/api/admin/dashboard-stats': { hasData: true },
    '/api/matrix/default-filter': null,
  };
  const FILTER = { conditions: [{ field: 'x', value: 'y' }] };

  const runWith = (matrixBody) => renderHook(() => useMatrix(FILTER), {
    wrapper: makeWrapper({
      auth: { authFetch: makeAuthFetch({ '/api/matrix/data': matrixBody, ...REFERENCE }) },
    }).wrapper,
  });

  it('passes every roll-up field through untouched', async () => {
    // Each field carries a DIFFERENT value, so a mapper that reads the wrong
    // source key produces a different object rather than coincidentally the same
    // one. Booleans are true and maxDepth is 4 precisely because those are not
    // the defaults — a surviving `|| false` would be invisible against false.
    const body = {
      rollup: 'department',
      rollupKind: 'context',
      rollupContextId: 'ctx-9',
      focusId: 'node-7',
      breadcrumb: [{ id: 'b1' }],
      nodes: [{ id: 'n1' }],
      rollupContent: 'roles-only',
      layered: true,
      layeredAttributes: true,
      maxDepth: 4,
      resources: [{ resourceId: 'r1' }],
      groupValues: ['IT'],
      groupTotals: [{ groupValue: 'IT', total: 3 }],
      counts: [{ resourceId: 'r1', groupValue: 'IT', directCount: 4 }],
      businessRoles: [{ roleId: 'br1' }],
      roleCounts: [{ roleId: 'br1', count: 2 }],
      roleRows: [{ roleId: 'br1', groupValue: 'IT' }],
      cells: [{ resourceId: 'r1', groupValue: 'IT' }],
    };
    const { result } = runWith(body);

    await waitFor(() => expect(result.current.rollup).not.toBe(null));
    // The whole object at once: any field defaulted over, or read from the wrong
    // key, fails here rather than needing its own assertion.
    expect(result.current.rollup).toEqual({
      attribute: 'department',
      rollupKind: 'context',
      rollupContextId: 'ctx-9',
      focusId: 'node-7',
      breadcrumb: [{ id: 'b1' }],
      nodes: [{ id: 'n1' }],
      rollupContent: 'roles-only',
      layered: true,
      layeredAttributes: true,
      maxDepth: 4,
      resources: [{ resourceId: 'r1' }],
      groupValues: ['IT'],
      groupTotals: [{ groupValue: 'IT', total: 3 }],
      counts: [{ resourceId: 'r1', groupValue: 'IT', directCount: 4 }],
      businessRoles: [{ roleId: 'br1' }],
      roleCounts: [{ roleId: 'br1', count: 2 }],
      roleRows: [{ roleId: 'br1', groupValue: 'IT' }],
      cells: [{ resourceId: 'r1', groupValue: 'IT' }],
    });
  });

  it('fills in a documented default for every roll-up field the server omits', async () => {
    // A minimal payload — only the field that selects the roll-up branch at all.
    // Collections must become empty arrays rather than undefined: the renderer
    // maps over them, so undefined is a crash or a blank grid, not a default.
    const { result } = runWith({ rollup: 'department' });

    await waitFor(() => expect(result.current.rollup).not.toBe(null));
    expect(result.current.rollup).toEqual({
      attribute: 'department',
      rollupKind: 'attribute',
      rollupContextId: null,
      focusId: null,
      breadcrumb: [],
      nodes: [],
      rollupContent: 'resources-and-roles',
      layered: false,
      layeredAttributes: false,
      maxDepth: 1,
      resources: [],
      groupValues: [],
      groupTotals: [],
      counts: [],
      businessRoles: [],
      roleCounts: [],
      roleRows: [],
      cells: [],
    });
  });

  it('passes the five headline counts through, and zeroes the ones omitted', async () => {
    // Five different non-zero values: a mapper reading the wrong key swaps two of
    // them, which identical numbers would hide.
    const { result } = runWith({
      rows: [], subjectCount: 3, subjectTotal: 11, resourceCount: 5,
      resourceTotal: 17, assignmentCount: 23,
    });
    await waitFor(() => expect(result.current.counts.subjectCount).toBe(3));
    expect(result.current.counts).toEqual({
      subjectCount: 3, subjectTotal: 11, resourceCount: 5,
      resourceTotal: 17, assignmentCount: 23,
    });

    const { result: sparse } = runWith({ rows: [], subjectCount: 3 });
    await waitFor(() => expect(sparse.current.counts.subjectCount).toBe(3));
    // Zero, not undefined — these render straight into the header counters.
    expect(sparse.current.counts).toEqual({
      subjectCount: 3, subjectTotal: 0, resourceCount: 0,
      resourceTotal: 0, assignmentCount: 0,
    });
  });
});

// ── Reference-data failures ─────────────────────────────────────────────────
// Four reference fetches run on mount, each with its own catch. None was ever
// made to fail, so every fallback was unexecuted — and they are not all the same
// fallback, which is the point: one fails CLOSED (no tags) and one fails OPEN
// (assume data exists). Getting either backwards is silent.
describe('useMatrix when reference data fails', () => {
  const rejectFor = (needle) => makeAuthFetch(async (url) => {
    if (String(url).includes(needle)) throw new Error('network');
    if (String(url).includes('/api/admin/dashboard-stats')) return { hasData: true };
    if (String(url).includes('/api/matrix/default-filter')) return { conditions: [] };
    return [];
  });

  const run = (authFetch) => renderHook(() => useMatrix(null), {
    wrapper: makeWrapper({ auth: { authFetch } }).wrapper,
  });

  it('falls back to no tags when the tag fetch fails', async () => {
    const { result } = run(rejectFor('/api/entity-tags'));
    // An empty Map, not null: null means "still loading" to every consumer.
    await waitFor(() => expect(result.current.groupTagMap).not.toBe(null));
    expect(result.current.groupTagMap.size).toBe(0);
  });

  it('assumes data exists when the has-data check fails', async () => {
    // Fails OPEN on purpose. hasData=false routes the user to an empty-state
    // screen telling them to import data; a transient failure must not do that
    // to a tenant whose data is fine.
    const { result } = run(rejectFor('/api/admin/dashboard-stats'));
    await waitFor(() => expect(result.current.hasData).toBe(true));
  });

  it('falls back to no default filter when that fetch fails', async () => {
    // null, not undefined: undefined is the "not yet loaded" sentinel the matrix
    // waits on, so returning it would hang the view rather than show it unfiltered.
    const { result } = run(rejectFor('/api/matrix/default-filter'));
    await waitFor(() => expect(result.current.defaultFilter).toBe(null));
  });
});
