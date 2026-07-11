// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import {
  renderHook, act, waitFor, makeAuthFetch, jsonResponse,
} from '@ui/test-utils/renderWithProviders';
import { useNestedGroupExpand } from './useNestedGroupExpand';

const baseFilter = { rowType: 'user', resource: { include: [], exclude: [] } };
const orderedGroups = [{ id: 'g1' }, { id: 'g2' }];

function setup(overrides = {}) {
  const authFetch = overrides.authFetch || makeAuthFetch({
    '/api/groups-with-nested': { groupIds: ['g1'] },
    '/api/group/': jsonResponse({ groups: [{ groupId: 'gp' }], memberships: [{ memberId: 'u1' }] }),
  });
  const props = {
    authFetch,
    filter: baseFilter,
    storageKey: JSON.stringify(baseFilter),
    orderedGroups,
    ...overrides.props,
  };
  const view = renderHook((p) => useNestedGroupExpand(p), { initialProps: props });
  return { authFetch, props, view };
}

describe('useNestedGroupExpand', () => {
  it('fetches the expandable group ids on mount', async () => {
    const { view } = setup();
    await waitFor(() => expect(view.result.current.groupsWithNested.has('g1')).toBe(true));
  });

  it('toggleExpand POSTs the active filter, caches, and expands', async () => {
    const { authFetch, view } = setup();
    await act(async () => { await view.result.current.toggleExpand('g1'); });
    expect(authFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/group/g1/nested-groups'),
      expect.objectContaining({ method: 'POST', body: expect.stringContaining('resource') }),
    );
    expect(view.result.current.expandedGroups.has('g1')).toBe(true);
    expect(view.result.current.nestedDataCache.has('g1')).toBe(true);
  });

  it('toggleExpand on an already-expanded group collapses it (no refetch)', async () => {
    const { authFetch, view } = setup();
    await act(async () => { await view.result.current.toggleExpand('g1'); });
    expect(view.result.current.expandedGroups.has('g1')).toBe(true);
    const callsAfterExpand = authFetch.mock.calls.length;
    await act(async () => { await view.result.current.toggleExpand('g1'); });
    expect(view.result.current.expandedGroups.has('g1')).toBe(false);
    // Collapse path doesn't hit the network again.
    expect(authFetch.mock.calls.length).toBe(callsAfterExpand);
  });

  it('toggleExpand swallows a fetch error and leaves the group collapsed', async () => {
    const authFetch = vi.fn(async () => { throw new Error('boom'); });
    const { view } = setup({ authFetch });
    await act(async () => { await view.result.current.toggleExpand('g1'); });
    expect(view.result.current.expandedGroups.has('g1')).toBe(false);
    expect(view.result.current.loadingNested.has('g1')).toBe(false);
  });

  it('expandAll expands every top-level group that has nested groups', async () => {
    const { view } = setup();
    await waitFor(() => expect(view.result.current.groupsWithNested.has('g1')).toBe(true));
    await act(async () => { await view.result.current.expandAll(); });
    expect(view.result.current.expandedGroups.has('g1')).toBe(true);
    expect(view.result.current.expandedGroups.has('g2')).toBe(false); // g2 has no nesting
  });

  it('collapseAll clears the expansion', async () => {
    const { view } = setup();
    await act(async () => { await view.result.current.expandAll(); });
    act(() => { view.result.current.collapseAll(); });
    expect(view.result.current.expandedGroups.size).toBe(0);
  });

  it('drops the cache and collapses when the filter (storageKey) changes', async () => {
    const { props, view } = setup();
    await act(async () => { await view.result.current.toggleExpand('g1'); });
    expect(view.result.current.nestedDataCache.size).toBeGreaterThan(0);
    // A new storageKey means a new resource scope → stale nested data is dropped.
    view.rerender({ ...props, storageKey: 'changed-filter' });
    expect(view.result.current.nestedDataCache.size).toBe(0);
    expect(view.result.current.expandedGroups.size).toBe(0);
  });
});
