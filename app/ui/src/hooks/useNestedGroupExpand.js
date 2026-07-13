import { useState, useCallback, useEffect } from 'react';

// How deep the matrix expands nested groups (a group → the groups/roles it is a
// principal of → their parents …). Shared with MatrixView's row builder.
export const MAX_NEST_LEVEL = 4;

// Fetch every not-yet-cached group in `ids` (POSTing the active filter via
// `fetchNestedGroups`) and write the results into `cache`. A failed fetch caches
// an empty result so the level still resolves.
async function fetchNestedLevel(ids, fetchNestedGroups, cache) {
  const results = await Promise.all(
    ids.map(id =>
      fetchNestedGroups(id)
        .then(r => r.json())
        .then(data => ({ id, data }))
        .catch(() => ({ id, data: { groups: [], memberships: [] } }))
    )
  );
  for (const { id, data } of results) cache.set(id, data);
}

// From the groups just expanded, the next level to expand: their nested groups
// that are themselves expandable and not already being expanded.
function nextExpandableLevel(currentLevel, cache, groupsWithNested, alreadyExpanding) {
  const next = [];
  for (const id of currentLevel) {
    for (const ng of (cache.get(id)?.groups || [])) {
      if (groupsWithNested.has(ng.groupId) && !alreadyExpanding.has(ng.groupId)) next.push(ng.groupId);
    }
  }
  return next;
}

// Run `reset()` during render whenever `key` changes — React's "adjust state
// when a prop changes" pattern, without an effect (which would trip
// react-hooks/set-state-in-effect).
function useResetOnKeyChange(key, reset) {
  const [seen, setSeen] = useState(key);
  if (key !== seen) {
    setSeen(key);
    reset();
  }
}

// Owns the matrix's nested-group expand state and fetches. Opening a group row
// reveals every resource its members inherit access to; the fetch POSTs the
// active matrix filter so nested resources honour the same resource-type scope
// as the grid (e.g. filtering to Groups doesn't leak AppRoles into the nesting).
// Because the nested data is filter-scoped, the cache is dropped — and rows
// collapsed — whenever the filter (storageKey) changes.
//
//   authFetch      — auth-wrapped fetch
//   filter         — the active matrix filter, POSTed to the nesting endpoint
//   storageKey      — stable string form of the filter; a change invalidates the cache
//   orderedGroups  — the currently rendered top-level group rows (for Expand All)
export function useNestedGroupExpand({ authFetch, filter, storageKey, orderedGroups }) {
  const [groupsWithNested, setGroupsWithNested] = useState(new Set());
  const [expandedGroups, setExpandedGroups] = useState(new Set());
  const [nestedDataCache, setNestedDataCache] = useState(new Map());
  const [loadingNested, setLoadingNested] = useState(new Set());

  // Which group rows get an expand affordance — fetched once on mount.
  useEffect(() => {
    let cancelled = false;
    authFetch('/api/groups-with-nested')
      .then(r => r.ok ? r.json() : { groupIds: [] })
      .then(d => { if (!cancelled) setGroupsWithNested(new Set(d.groupIds || [])); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [authFetch]);

  // Single place that builds the nested-expand request — POSTs the active filter
  // so the backend constrains nested resources to the grid's resource-type scope.
  const fetchNestedGroups = useCallback((id) =>
    authFetch(`/api/group/${encodeURIComponent(id)}/nested-groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter }),
    }), [authFetch, filter]);

  const toggleExpand = useCallback(async (groupId) => {
    if (expandedGroups.has(groupId)) {
      setExpandedGroups(prev => { const next = new Set(prev); next.delete(groupId); return next; });
      return;
    }
    if (!nestedDataCache.has(groupId)) {
      setLoadingNested(prev => new Set(prev).add(groupId));
      try {
        const res = await fetchNestedGroups(groupId);
        const data = await res.json();
        setNestedDataCache(prev => new Map(prev).set(groupId, data));
      } catch (err) {
        console.error('Failed to load nested groups:', err);
        setLoadingNested(prev => { const next = new Set(prev); next.delete(groupId); return next; });
        return;
      }
      setLoadingNested(prev => { const next = new Set(prev); next.delete(groupId); return next; });
    }
    setExpandedGroups(prev => new Set(prev).add(groupId));
  }, [expandedGroups, nestedDataCache, fetchNestedGroups]);

  const expandAll = useCallback(async () => {
    const newCache = new Map(nestedDataCache);
    const toExpand = new Set();

    // Start with visible groups that have nested groups, then walk down.
    let currentLevel = orderedGroups
      .map(g => g.realGroupId || g.id)
      .filter(id => groupsWithNested.has(id));

    for (let level = 0; level < MAX_NEST_LEVEL && currentLevel.length > 0; level++) {
      const toFetch = currentLevel.filter(id => !newCache.has(id));
      if (toFetch.length > 0) {
        setLoadingNested(new Set(toFetch));
        await fetchNestedLevel(toFetch, fetchNestedGroups, newCache);
      }
      for (const id of currentLevel) toExpand.add(id);
      currentLevel = nextExpandableLevel(currentLevel, newCache, groupsWithNested, toExpand);
    }

    setNestedDataCache(newCache);
    setExpandedGroups(toExpand);
    setLoadingNested(new Set());
  }, [orderedGroups, groupsWithNested, nestedDataCache, fetchNestedGroups]);

  const collapseAll = useCallback(() => {
    setExpandedGroups(new Set());
  }, []);

  // Nested data is filter-scoped → drop it (and collapse) when the filter changes.
  useResetOnKeyChange(storageKey, () => {
    setNestedDataCache(new Map());
    setExpandedGroups(new Set());
  });

  return {
    groupsWithNested, expandedGroups, nestedDataCache, loadingNested,
    toggleExpand, expandAll, collapseAll,
  };
}
