// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor, act, makeWrapper, makeAuthFetch } from '@ui/test-utils/renderWithProviders';
import { useContextRoots, useContextForest, subtreeUrl, forestNodes, flattenTree } from './useContextTrees';

// authFetch is read from AuthContext inside these hooks, so wrap with makeWrapper.
function rootsWrapper(handler) {
  return makeWrapper({ auth: { authFetch: makeAuthFetch(handler) } }).wrapper;
}

describe('useContextRoots', () => {
  it('loads roots from /api/contexts (body.data)', async () => {
    const wrapper = rootsWrapper({ '/api/contexts': { data: [{ id: 'r1' }, { id: 'r2' }] } });
    const { result } = renderHook(() => useContextRoots(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.roots).toHaveLength(2);
    expect(result.current.error).toBeNull();
  });

  it('exposes a string error on failure', async () => {
    const wrapper = rootsWrapper(() => undefined); // unmatched → 404
    const { result } = renderHook(() => useContextRoots(), { wrapper });
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(typeof result.current.error).toBe('string');
  });
});

describe('subtreeUrl / forestNodes', () => {
  it('encodes the root id into the tree URL', () => {
    expect(subtreeUrl('a b/c')).toBe('/api/contexts/tree?root=a%20b%2Fc');
  });

  it('marks unread roots pending and adds a read subtree\'s children under the roots row', () => {
    const roots = [
      { id: 'r1', displayName: 'Roots name', sourceAlgorithmName: 'manager-hierarchy', totalMemberCount: 1 },
      { id: 'r2', displayName: 'Unread' },
    ];
    const loaded = new Map([['r1', { id: 'r1', displayName: 'Tree name', totalMemberCount: 5, description: 'from the tree', children: [{ id: 'c1' }] }]]);
    const [r1, r2] = forestNodes(roots, loaded);
    // The roots row wins for the root; the subtree adds what the row lacks.
    expect(r1).toMatchObject({ displayName: 'Roots name', totalMemberCount: 1, sourceAlgorithmName: 'manager-hierarchy', description: 'from the tree' });
    expect(r1.children.map(c => c.id)).toEqual(['c1']);
    expect(r1.childrenPending).toBeUndefined();
    expect(r2).toMatchObject({ id: 'r2', children: [], childrenPending: true });
    // A subtree without a children array still yields an empty list.
    expect(forestNodes([{ id: 'x' }], new Map([['x', { id: 'x' }]]))[0].children).toEqual([]);
    expect(forestNodes(null, new Map())).toEqual([]);
  });
});

describe('useContextForest', () => {
  const ROOTS = [{ id: 'r1' }, { id: 'r2' }];

  it('reads a root\'s subtree once, on load, and leaves the others pending', async () => {
    const authFetch = makeAuthFetch((url) => (url.includes('root=r1') ? [{ id: 'r1', children: [{ id: 'c1' }] }] : undefined));
    const wrapper = makeWrapper({ auth: { authFetch } }).wrapper;
    const { result } = renderHook(() => useContextForest(ROOTS), { wrapper });
    expect(authFetch).not.toHaveBeenCalled();
    expect(result.current.nodes.every(n => n.childrenPending)).toBe(true);

    act(() => { result.current.load('r1'); });
    await waitFor(() => expect(result.current.nodes[0].children).toHaveLength(1));
    expect(result.current.nodes[1].childrenPending).toBe(true);

    // Loading it again does not refetch; a null id is ignored.
    act(() => { result.current.load('r1'); result.current.load(null); });
    expect(authFetch).toHaveBeenCalledTimes(1);

    // reload() re-reads only what was loaded.
    await act(async () => { await result.current.reload(); });
    expect(authFetch).toHaveBeenCalledTimes(2);
    expect(authFetch.mock.calls.every(([u]) => u === '/api/contexts/tree?root=r1')).toBe(true);
  });

  it('a failed read leaves the root with no children instead of pending', async () => {
    const authFetch = makeAuthFetch(() => undefined); // 404
    const wrapper = makeWrapper({ auth: { authFetch } }).wrapper;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = renderHook(() => useContextForest(ROOTS), { wrapper });
    act(() => { result.current.load('r2'); });
    await waitFor(() => expect(result.current.nodes[1].childrenPending).toBeUndefined());
    expect(result.current.nodes[1].children).toEqual([]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('flattenTree', () => {
  it('flattens nested children with depth markers', () => {
    const flat = flattenTree([
      { id: 'a', children: [{ id: 'b', children: [{ id: 'c' }] }] },
      { id: 'd' },
    ]);
    expect(flat.map((n) => [n.id, n._depth])).toEqual([['a', 0], ['b', 1], ['c', 2], ['d', 0]]);
  });
});
