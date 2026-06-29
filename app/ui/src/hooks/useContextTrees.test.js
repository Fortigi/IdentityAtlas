// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor, makeWrapper, makeAuthFetch } from '@ui/test-utils/renderWithProviders';
import { useContextRoots, useContextSubtree, flattenTree } from './useContextTrees';

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

describe('useContextSubtree', () => {
  it('does not fetch when rootId is falsy', () => {
    const authFetch = makeAuthFetch({});
    const wrapper = makeWrapper({ auth: { authFetch } }).wrapper;
    const { result } = renderHook(() => useContextSubtree(null), { wrapper });
    expect(authFetch).not.toHaveBeenCalled();
    expect(result.current.nodes).toEqual([]);
  });

  it('loads the subtree for a rootId', async () => {
    const wrapper = rootsWrapper((url) =>
      url.includes('/api/contexts/tree') ? [{ id: 'n1' }, { id: 'n2' }] : undefined,
    );
    const { result } = renderHook(() => useContextSubtree('root-1'), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.nodes).toHaveLength(2);
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
