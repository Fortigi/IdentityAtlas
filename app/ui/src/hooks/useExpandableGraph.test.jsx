// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook, act, makeWrapper, makeAuthFetch } from '@ui/test-utils/renderWithProviders';
import useExpandableGraph from '@ui/hooks/useExpandableGraph';

// Root-ring spec for a user page: two categories we can drill into.
const ROOT_NODES = [
  { key: 'assignments-direct', label: 'Direct', count: 2, kind: 'category' },
  { key: 'contexts', label: 'Contexts', count: 1, kind: 'category' },
];

function setup({ authFetch, rootNodes = ROOT_NODES, rootExtras = {} } = {}) {
  const af = authFetch || makeAuthFetch({});
  const { wrapper } = makeWrapper({ auth: { authFetch: af } });
  const { result } = renderHook(
    () => useExpandableGraph({
      rootEntityKind: 'user',
      rootEntityId: 'u1',
      rootExtras,
      rootNodes,
      authFetch: af,
    }),
    { wrapper },
  );
  return { result, authFetch: af };
}

describe('useExpandableGraph — initial state', () => {
  it('starts collapsed with the raw root nodes and no active list', () => {
    const { result } = setup();
    expect(result.current.pathDepth).toBe(0);
    expect(result.current.expandedPath).toEqual([]);
    expect(result.current.nodesWithExpansion).toBe(ROOT_NODES);
    expect(result.current.activeListItems).toBeNull();
    expect(result.current.activeListLabel).toBeNull();
    expect(result.current.activeListKind).toBeNull();
    expect(result.current.loading).toBe(false);
  });
});

describe('useExpandableGraph — category expansion', () => {
  it('fetches a category list, attaches it as children, and exposes the active list', async () => {
    const af = makeAuthFetch({
      '/api/user/u1/memberships': [
        { resourceId: 'g1', resourceDisplayName: 'Finance', membershipType: 'Direct' },
        { resourceId: 'g2', resourceDisplayName: 'HR', membershipType: 'Indirect' },
      ],
    });
    const { result } = setup({ authFetch: af });

    await act(async () => {
      await result.current.handleNodeClick({ key: 'assignments-direct', kind: 'category' });
    });

    expect(result.current.pathDepth).toBe(1);
    expect(result.current.expandedPath).toEqual(['assignments-direct']);

    // Only the Direct membership survives the filter.
    expect(result.current.activeListItems).toHaveLength(1);
    expect(result.current.activeListItems[0]).toMatchObject({ key: 'resource:g1', label: 'Finance' });
    expect(result.current.activeListLabel).toBe('Direct');
    expect(result.current.activeListKind).toBe('assignments-direct');

    // The nested tree carries the children under the matching root node.
    const direct = result.current.nodesWithExpansion.find((n) => n.key === 'assignments-direct');
    expect(direct.children).toHaveLength(1);
  });

  it('caps the GRAPH ring children with an overflow marker while the active list stays full', async () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      resourceId: `g${i}`, resourceDisplayName: `G${i}`, membershipType: 'Direct',
    }));
    const af = makeAuthFetch({ '/api/user/u1/memberships': many });
    const { result } = setup({ authFetch: af });

    await act(async () => {
      await result.current.handleNodeClick({ key: 'assignments-direct', kind: 'category' });
    });

    const direct = result.current.nodesWithExpansion.find((n) => n.key === 'assignments-direct');
    expect(direct.children).toHaveLength(10); // capped
    expect(direct.children[9].overflow).toBe(true);
    // The list below the graph keeps the full set.
    expect(result.current.activeListItems).toHaveLength(15);
  });

  it('toggles a node closed when clicked a second time', async () => {
    const af = makeAuthFetch({
      '/api/user/u1/memberships': [{ resourceId: 'g1', resourceDisplayName: 'Finance', membershipType: 'Direct' }],
    });
    const { result } = setup({ authFetch: af });

    await act(async () => {
      await result.current.handleNodeClick({ key: 'assignments-direct', kind: 'category' });
    });
    expect(result.current.pathDepth).toBe(1);

    await act(async () => {
      await result.current.handleNodeClick({ key: 'assignments-direct', kind: 'category' });
    });
    expect(result.current.pathDepth).toBe(0);
    expect(result.current.activeListItems).toBeNull();
  });
});

describe('useExpandableGraph — item drill-down', () => {
  it('drills into an expandable item, fetching its core and attaching category children', async () => {
    const af = makeAuthFetch({
      '/api/user/u1/memberships': [{ resourceId: 'g1', resourceDisplayName: 'Finance', membershipType: 'Direct' }],
      // Drilling into the resource item fetches the resource core.
      '/api/resources/g1': {
        assignmentByType: { Direct: 5 },
        contextCount: 0,
      },
    });
    const { result } = setup({ authFetch: af });

    // Expand the category first to surface the item.
    await act(async () => {
      await result.current.handleNodeClick({ key: 'assignments-direct', kind: 'category' });
    });
    const item = result.current.activeListItems[0];
    expect(item.kind).toBe('item');

    // Now drill into the resource item.
    await act(async () => {
      await result.current.handleNodeClick(item);
    });

    expect(result.current.pathDepth).toBe(2);
    expect(result.current.expandedPath).toEqual(['assignments-direct', item.key]);

    // The item step attaches the resource's root category nodes as children.
    const direct = result.current.nodesWithExpansion.find((n) => n.key === 'assignments-direct');
    const itemNode = direct.children.find((c) => c.key === item.key);
    expect(itemNode.children.some((c) => c.key === 'members-direct')).toBe(true);

    // The active list still reflects the deepest CATEGORY step (depth 0), since the
    // item step is not a category.
    expect(result.current.activeListKind).toBe('assignments-direct');
  });

  it('does nothing for a non-expandable item kind', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.handleNodeClick({ key: 'leaf:x', kind: 'item', entityKind: 'leaf', entityId: 'x' });
    });
    expect(result.current.pathDepth).toBe(0);
  });

  it('ignores clicks on overflow markers', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.handleNodeClick({ key: '__overflow__', overflow: true });
    });
    expect(result.current.pathDepth).toBe(0);
  });

  it('ignores a null node', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.handleNodeClick(null);
    });
    expect(result.current.pathDepth).toBe(0);
  });

  it('aborts the drill when the item core fails to load', async () => {
    const af = makeAuthFetch({
      '/api/user/u1/memberships': [{ resourceId: 'g1', resourceDisplayName: 'Finance', membershipType: 'Direct' }],
      // No stub for /api/resources/g1 → 404 → fetchEntityCore returns null.
    });
    const { result } = setup({ authFetch: af });
    await act(async () => {
      await result.current.handleNodeClick({ key: 'assignments-direct', kind: 'category' });
    });
    const item = result.current.activeListItems[0];
    await act(async () => {
      await result.current.handleNodeClick(item);
    });
    // Core load failed, so no item step was pushed.
    expect(result.current.pathDepth).toBe(1);
  });
});

describe('useExpandableGraph — deriveLabel breadcrumb + reset', () => {
  it('builds a breadcrumb label across a category → item → category drill', async () => {
    // Most-specific key first: makeAuthFetch returns the first key that is a
    // substring of the URL, and '/api/resources/g1' is a substring of the
    // assignments URL too.
    const af = makeAuthFetch({
      '/api/user/u1/memberships': [{ resourceId: 'g1', resourceDisplayName: 'Finance', membershipType: 'Direct' }],
      '/api/resources/g1/assignments': [
        { principalId: 'p1', principalDisplayName: 'Alice', assignmentType: 'Direct' },
      ],
      '/api/resources/g1': { assignmentByType: { Direct: 1 }, contextCount: 0 },
    });
    const { result } = setup({ authFetch: af });

    await act(async () => {
      await result.current.handleNodeClick({ key: 'assignments-direct', kind: 'category' });
    });
    const item = result.current.activeListItems[0];
    await act(async () => {
      await result.current.handleNodeClick(item);
    });
    // Drill into the resource's "Direct Members" category.
    await act(async () => {
      await result.current.handleNodeClick({ key: 'members-direct', kind: 'category' });
    });

    expect(result.current.pathDepth).toBe(3);
    expect(result.current.activeListKind).toBe('members-direct');
    // Breadcrumb spans all three drilled steps.
    expect(result.current.activeListLabel).toBe('Direct → Finance → Direct Members');
    expect(result.current.activeListItems[0]).toMatchObject({ key: 'user:p1', label: 'Alice' });
  });

  it('reset() drops the whole expansion', async () => {
    const af = makeAuthFetch({
      '/api/user/u1/memberships': [{ resourceId: 'g1', resourceDisplayName: 'Finance', membershipType: 'Direct' }],
    });
    const { result } = setup({ authFetch: af });
    await act(async () => {
      await result.current.handleNodeClick({ key: 'assignments-direct', kind: 'category' });
    });
    expect(result.current.pathDepth).toBe(1);
    act(() => {
      result.current.reset();
    });
    expect(result.current.pathDepth).toBe(0);
    expect(result.current.activeListItems).toBeNull();
  });
});
