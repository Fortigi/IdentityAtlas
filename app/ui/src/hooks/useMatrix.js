// Data-fetching hook for the wizard-driven Matrix tab.
//
// Replaces (most of) usePermissions for the new flow:
//   - No fetch happens until the caller supplies a filter with at least one
//     condition. Until then `data` is an empty array and `loading` is false.
//   - When the filter changes, POSTs to /api/matrix/data (debounced 400ms).
//   - Access-package groups + group tag map are still fetched once on mount
//     (they don't depend on the filter and are used to render SOLL columns
//     and the tag column).
//
// Shape returned matches what MatrixView consumed from usePermissions, plus
// the new preview counts and rowType marker.

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useAuth } from '../auth/AuthGate';

const GROUP_COL_ALIASES = {
  displayName:      'resourceDisplayName',
  description:      'resourceDescription',
  groupDisplayName: 'resourceDisplayName',
  groupDescription: 'resourceDescription',
};

export function useMatrix(filter) {
  const { authFetch } = useAuth();

  // Filter-driven data
  const [data, setData] = useState([]);
  const [rowType, setRowType] = useState('principal');
  const [counts, setCounts] = useState({
    subjectCount: 0, subjectTotal: 0,
    resourceCount: 0, resourceTotal: 0,
    assignmentCount: 0,
  });
  const [managedByPackages, setManagedByPackages] = useState([]);
  // Roll-up payload (null when not in roll-up mode):
  //   { attribute, resources:[…], groupValues:[…], counts:[{resourceId,groupValue,directCount}] }
  const [rollup, setRollup] = useState(null);
  const [loading, setLoading]       = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError]           = useState(null);

  // Static-ish reference data (independent of filter)
  const [accessPackageGroups, setAccessPackageGroups] = useState([]);
  const [groupTagMap, setGroupTagMap] = useState(null);
  // userColumns kept for backwards-compat with MatrixView's filterFields
  // discovery — populated only when rowType=principal.
  const [userColumns, setUserColumns] = useState(null);

  const [refreshCounter, setRefreshCounter] = useState(0);
  const forceRefresh = useCallback(() => setRefreshCounter(c => c + 1), []);

  // null = still checking, true = DB has data, false = DB is empty
  const [hasData, setHasData] = useState(null);
  // undefined = still loading, null = no default, object = default filter row
  const [defaultFilter, setDefaultFilter] = useState(undefined);
  // Incrementing this triggers a re-fetch of hasData + defaultFilter.
  const [preCheckVersion, setPreCheckVersion] = useState(0);
  const refetchPreChecks = useCallback(() => setPreCheckVersion(v => v + 1), []);

  // Load access-package groups + tags + Principal column metadata once.
  useEffect(() => {
    let cancelled = false;
    authFetch('/api/access-package-groups')
      .then(r => r.ok ? r.json() : [])
      .then(rows => { if (!cancelled) setAccessPackageGroups(Array.isArray(rows) ? rows : []); })
      .catch(() => {});
    authFetch('/api/entity-tags?entityType=resource')
      .then(r => r.ok ? r : authFetch('/api/entity-tags?entityType=group'))
      .then(res => res.ok ? res.json() : [])
      .then(rows => {
        if (cancelled) return;
        const map = new Map();
        for (const r of rows) {
          const key = r.entityId?.toUpperCase();
          if (!key) continue;
          if (!map.has(key)) map.set(key, []);
          map.get(key).push({ id: r.tagId, name: r.tagName, color: r.tagColor });
        }
        setGroupTagMap(map);
      })
      .catch(() => { if (!cancelled) setGroupTagMap(new Map()); });
    authFetch('/api/user-columns')
      .then(r => r.ok ? r.json() : [])
      .then(cols => { if (!cancelled) setUserColumns(cols); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [authFetch]);

  // hasData + defaultFilter are re-fetched on every fresh navigation to the
  // matrix tab (via refetchPreChecks) so that data loaded after mount — e.g.
  // a demo import or crawler run — is picked up without a page refresh.
  useEffect(() => {
    let cancelled = false;
    setHasData(null);
    setDefaultFilter(undefined);
    authFetch('/api/admin/dashboard-stats')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled) setHasData(d ? (d.hasData !== false) : true); })
      .catch(() => { if (!cancelled) setHasData(true); });
    authFetch('/api/matrix/default-filter')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled) setDefaultFilter(d || null); })
      .catch(() => { if (!cancelled) setDefaultFilter(null); });
    return () => { cancelled = true; };
  }, [authFetch, preCheckVersion]);

  // Stable cache key for the filter — only re-fetch when conditions change.
  const filterKey = useMemo(() => filter ? JSON.stringify(filter) : null, [filter]);
  const hasConditions = filter !== null && filter !== undefined;

  // Debounce filter changes.
  const [debouncedKey, setDebouncedKey] = useState(filterKey);
  const timerRef = useRef(null);
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setDebouncedKey(filterKey), 400);
    return () => clearTimeout(timerRef.current);
  }, [filterKey]);

  // Fetch matrix data when the debounced filter changes.
  useEffect(() => {
    if (!hasConditions) {
      setData([]);
      setManagedByPackages([]);
      setRollup(null);
      setCounts({ subjectCount: 0, subjectTotal: 0, resourceCount: 0, resourceTotal: 0, assignmentCount: 0 });
      setLoading(false);
      setRefreshing(false);
      setError(null);
      return;
    }
    // hasConditions is true but the debounce hasn't fired yet — wait for debouncedKey.
    if (!debouncedKey) return;
    const controller = new AbortController();
    let cancelled = false;
    (async () => {
      try {
        if (data.length === 0) setLoading(true);
        setRefreshing(true);
        const res = await authFetch('/api/matrix/data', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Server expects { filter: {...} }, not the bare filter object.
          body: `{"filter":${debouncedKey}}`,
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        const body = await res.json();
        if (cancelled) return;
        if (body.rollup) {
          setRollup({
            attribute:     body.rollup,
            rollupKind:    body.rollupKind    || 'attribute',
            rollupContextId: body.rollupContextId || null,
            focusId:       body.focusId       || null,
            breadcrumb:    body.breadcrumb    || [],
            nodes:         body.nodes         || [],
            rollupContent: body.rollupContent || 'resources-and-roles',
            layered:       body.layered       || false,
            layeredAttributes: body.layeredAttributes || false,
            maxDepth:      body.maxDepth       || 1,
            resources:     body.resources     || [],
            groupValues:   body.groupValues   || [],
            groupTotals:   body.groupTotals   || [],
            counts:        body.counts        || [],
            businessRoles: body.businessRoles || [],
            roleCounts:    body.roleCounts    || [],
            roleRows:      body.roleRows      || [],
            cells:         body.cells         || [],
          });
          setData([]);
          setManagedByPackages([]);
        } else {
          setRollup(null);
          setData(body.data || []);
          setManagedByPackages(body.managedByPackages || []);
        }
        setRowType(body.rowType || 'principal');
        setCounts({
          subjectCount:    body.subjectCount    || 0,
          subjectTotal:    body.subjectTotal    || 0,
          resourceCount:   body.resourceCount   || 0,
          resourceTotal:   body.resourceTotal   || 0,
          assignmentCount: body.assignmentCount || 0,
        });
        setError(null);
      } catch (err) {
        if (cancelled || err.name === 'AbortError') return;
        setError(err.message || 'Failed to load matrix');
      } finally {
        if (!cancelled) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    })();
    return () => { cancelled = true; controller.abort(); };
  }, [debouncedKey, hasConditions, refreshCounter, authFetch, data.length]);

  // accessPackageGroups uses the legacy alias scheme (resource/group columns) — keep it.
  const accessPackageGroupsAliased = useMemo(() => {
    if (!Array.isArray(accessPackageGroups)) return [];
    return accessPackageGroups.map(r => {
      const out = { ...r };
      for (const [alias, target] of Object.entries(GROUP_COL_ALIASES)) {
        if (out[alias] !== undefined && out[target] === undefined) out[target] = out[alias];
      }
      return out;
    });
  }, [accessPackageGroups]);

  return {
    data,
    rollup,
    rowType,
    counts,
    totalUsers: counts.subjectTotal,
    accessPackageGroups: accessPackageGroupsAliased,
    managedByPackages,
    groupTagMap,
    userColumns,
    loading,
    refreshing,
    error,
    forceRefresh,
    hasData,
    defaultFilter,
    refetchPreChecks,
  };
}

