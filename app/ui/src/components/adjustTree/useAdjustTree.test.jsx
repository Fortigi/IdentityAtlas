// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook, makeWrapper, makeAuthFetch, jsonResponse, waitFor, act } from '@ui/test-utils/renderWithProviders';
import { useAdjustTree, treeUrl } from './useAdjustTree';
import { TREE, ADJUSTMENTS, ATTENTION, adjustTreeApi } from '@ui/test-utils/adjustTreeFixtures';

function setup(authFetch, key = 'org:1') {
  const { result } = renderHook(() => useAdjustTree(key), { wrapper: makeWrapper({ auth: { authFetch } }).wrapper });
  return result;
}

describe('treeUrl', () => {
  it('encodes the tree key into the path', () => {
    expect(treeUrl('synced:3/LogicalApplication')).toBe('/api/context-trees/synced%3A3%2FLogicalApplication');
    expect(treeUrl('k', '/attention')).toBe('/api/context-trees/k/attention');
  });
});

describe('useAdjustTree', () => {
  it('reads the tree, its adjustments and what needs attention together', async () => {
    const result = setup(adjustTreeApi());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tree.name).toBe(TREE.name);
    expect(result.current.adjustments.map(a => a.id)).toEqual(ADJUSTMENTS.map(a => a.id));
    expect(result.current.attention.map(a => a.id)).toEqual(ATTENTION.map(a => a.id));
    expect(result.current.version).toBe(1);
    expect(result.current.error).toBeNull();
  });

  it('says a tree was not found on a bare 404, and gives the API\'s own message otherwise', async () => {
    const notFound = setup(makeAuthFetch(() => jsonResponse(null, { ok: false, status: 404 })));
    await waitFor(() => expect(notFound.current.error).toBe('This tree was not found.'));
    const denied = setup(makeAuthFetch(() => jsonResponse({ error: 'Forbidden here' }, { ok: false, status: 403 })));
    await waitFor(() => expect(denied.current.error).toBe('Forbidden here'));
    const broken = setup(makeAuthFetch(() => jsonResponse(null, { ok: false, status: 500 })));
    await waitFor(() => expect(broken.current.error).toBe('HTTP 500'));
    expect(broken.current.tree).toBeNull();
  });

  it('reads everything again after a write, and hands back the adjustment', async () => {
    const api = adjustTreeApi();
    const result = setup(api);
    await waitFor(() => expect(result.current.version).toBe(1));
    let adj;
    await act(async () => { adj = await result.current.post({ op: 'renameUnit', subjectId: 'u-it', name: 'X' }); });
    expect(adj).toEqual({ id: 'a11', subjectId: 'u-it', status: 'active', description: 'Done renameUnit' });
    expect(result.current.version).toBe(2);
  });

  it('throws the API\'s refusal of a write, and the status without one', async () => {
    const refusing = setup(adjustTreeApi({ fail: 'Not allowed' }));
    await waitFor(() => expect(refusing.current.version).toBe(1));
    await expect(refusing.current.undo('a2')).rejects.toThrow('Not allowed');
    const api = makeAuthFetch((url, opts) => (opts?.method ? jsonResponse('nope', { ok: false, status: 502 }) : adjustTreeApi()(url)));
    const bare = setup(api);
    await waitFor(() => expect(bare.current.version).toBe(1));
    await expect(bare.current.redo('a0')).rejects.toThrow('HTTP 502');
  });

  it('reads the tree again even when a grouping fails half way', async () => {
    let posts = 0;
    const base = adjustTreeApi({ treeAfterWrite: { ...TREE, units: [...TREE.units, { ...TREE.units[4], id: 'u-g', name: 'G', parentId: null }] } });
    const api = makeAuthFetch((url, opts) => {
      if (opts?.method === 'POST' && ++posts === 2) return jsonResponse({ error: 'Unit gone' }, { ok: false, status: 404 });
      return base(url, opts);
    });
    const result = setup(api);
    await waitFor(() => expect(result.current.version).toBe(1));
    await act(async () => {
      await expect(result.current.groupUnits({ name: 'G', parentId: null, unitIds: ['u-fin', 'u-it'] })).rejects.toThrow('Unit gone');
    });
    expect(result.current.version).toBe(2);
  });
});
