import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useAuth } from '../auth/AuthGate';

const API_BASE = '/api';

// GraphGroups/GraphResources column names → permission query aliases (for Matrix tab)
const GROUP_COL_ALIASES = {
  displayName: 'resourceDisplayName',
  description: 'resourceDescription',
  // Legacy aliases for backward compat
  groupDisplayName: 'resourceDisplayName',
  groupDescription: 'resourceDescription',
};

export function usePermissions(userLimit = 25, activeFilters = []) {
  const { authFetch } = useAuth();
  const [data, setData] = useState([]);
  const [totalUsers, setTotalUsers] = useState(0);
  const [refreshCounter, setRefreshCounter] = useState(0);
  const forceRefresh = useCallback(() => setRefreshCounter(c => c + 1), []);
  const [accessPackageGroups, setAccessPackageGroups] = useState([]);
  const [managedByPackages, setManagedByPackages] = useState([]);
  const [userColumns, setUserColumns] = useState(null); // null = loading
  const [groupColumns, setGroupColumns] = useState(null); // null = loading
  const [groupTagMap, setGroupTagMap] = useState(null); // null = loading, Map<uppercaseGroupId, [{tagId, tagName, tagColor}]>
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false); // true during refetch (filter/limit change)
  const [error, setError] = useState(null);

  // Fetch user and group columns in two phases:
  //   Phase 1 (?schema=true): column names only, returns in ~100ms — unblocks server-filter
  //                           recognition so the first permissions fetch has the right filters.
  //   Phase 2 (full):         column names + distinct values, returns in 15-20s — populates
  //                           the filter dropdown options once the matrix is already showing.
  useEffect(() => {
    let cancelled = false;

    // Phase 1: fast schema (names only)
    Promise.all([
      authFetch(`${API_BASE}/user-columns?schema=true`).then(r => r.ok ? r.json() : []).catch(() => []),
      authFetch(`${API_BASE}/resource-columns?schema=true`).then(r => r.ok ? r.json() : authFetch(`${API_BASE}/group-columns?schema=true`).then(r2 => r2.ok ? r2.json() : [])).catch(() => []),
    ]).then(([userCols, groupCols]) => {
      if (cancelled) return;
      setUserColumns(userCols);
      setGroupColumns(groupCols.map(c => ({ ...c, column: GROUP_COL_ALIASES[c.column] || c.column })));
    });

    // Phase 2: full values (slow — populates filter dropdowns in background)
    authFetch(`${API_BASE}/user-columns`)
      .then(res => res.ok ? res.json() : [])
      .then(cols => { if (!cancelled) setUserColumns(cols); })
      .catch(() => {});
    authFetch(`${API_BASE}/resource-columns`)
      .then(res => res.ok ? res.json() : authFetch(`${API_BASE}/group-columns`).then(r2 => r2.ok ? r2.json() : []))
      .then(cols => {
        if (cancelled) return;
        const aliased = cols.map(c => ({ ...c, column: GROUP_COL_ALIASES[c.column] || c.column }));
        setGroupColumns(aliased);
      })
      .catch(() => {});
    authFetch(`${API_BASE}/entity-tags?entityType=resource`).then(r => r.ok ? r : authFetch(`${API_BASE}/entity-tags?entityType=group`))
      .then(res => res.ok ? res.json() : [])
      .then(rows => {
        if (cancelled) return;
        // Build Map<uppercaseEntityId, [{tagId, tagName, tagColor}]>
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
    return () => { cancelled = true; };
  }, [authFetch]);

  // Derive server-side filters: user and group attribute columns go to the backend.
  // Other filters (membershipType, etc.) stay client-side.
  const userColumnNames = useMemo(() => {
    if (!userColumns) return new Set();
    return new Set(userColumns.map(c => c.column));
  }, [userColumns]);

  const groupColumnNames = useMemo(() => {
    if (!groupColumns) return new Set();
    return new Set(groupColumns.map(c => c.column));
  }, [groupColumns]);

  const serverFilters = useMemo(() => {
    const result = {};
    for (const f of activeFilters) {
      // Tag filters are always server-side — don't wait for column discovery
      if (f.field === '__userTag' || f.field === '__groupTag' ||
          userColumnNames.has(f.field) || groupColumnNames.has(f.field)) {
        result[f.field] = f.value;
      }
    }
    return result;
  }, [activeFilters, userColumnNames, groupColumnNames]);

  // Stable key for debounce comparison (avoids object reference changes)
  const serverFilterKey = useMemo(() => JSON.stringify(serverFilters), [serverFilters]);

  // Debounced server parameters: only triggers fetch after 400ms of no changes
  const [debouncedLimit, setDebouncedLimit] = useState(userLimit);
  const [debouncedFilterKey, setDebouncedFilterKey] = useState(serverFilterKey);
  const timerRef = useRef(null);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setDebouncedLimit(userLimit);
      setDebouncedFilterKey(serverFilterKey);
    }, 400);
    return () => clearTimeout(timerRef.current);
  }, [userLimit, serverFilterKey]);

  const fetchPermissions = useCallback(async (limit, filterJson, signal) => {
    const params = new URLSearchParams();
    if (limit > 0) params.set('userLimit', limit);
    const filters = JSON.parse(filterJson);
    if (Object.keys(filters).length > 0) params.set('filters', filterJson);
    const qs = params.toString();
    const url = `${API_BASE}/permissions${qs ? `?${qs}` : ''}`;
    const res = await authFetch(url, { signal });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
  }, [authFetch]);

  // Fetch data when debounced server parameters change
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    async function fetchData() {
      try {
        // Full loading spinner on initial load; subtle refreshing indicator on subsequent fetches
        if (data.length === 0) setLoading(true);
        setRefreshing(true);

        const [permResult, apRes] = await Promise.all([
          fetchPermissions(debouncedLimit, debouncedFilterKey, controller.signal),
          authFetch(`${API_BASE}/access-package-groups`, { signal: controller.signal }),
        ]);

        if (cancelled) return;
        setData(permResult.data);
        setTotalUsers(permResult.totalUsers);
        setManagedByPackages(permResult.managedByPackages || []);

        if (apRes.ok) {
          setAccessPackageGroups(await apRes.json());
        }
      } catch (err) {
        if (cancelled || err.name === 'AbortError') return;
        setError(err.message);
      } finally {
        if (!cancelled) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    }
    fetchData();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [debouncedLimit, debouncedFilterKey, fetchPermissions, authFetch, refreshCounter]);

  return { data, totalUsers, accessPackageGroups, managedByPackages, userColumns, groupTagMap, loading, refreshing, error, forceRefresh };
}
