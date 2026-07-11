import { useState, useEffect, useReducer, useCallback, useMemo, useRef } from 'react';
import { useDebouncedValue } from './useDebouncedValue';
import usePersistedState from './usePersistedState';
import { useDialog } from '@ui/components/dialogContext';

const PAGE_SIZE = 100;

/**
 * Shared hook for entity pages (Users, Groups).
 * Extracts all common state management, data fetching, filtering, sorting,
 * selection, and tag operations into a single reusable hook.
 *
 * @param {object} options
 * @param {Function} options.authFetch - Authenticated fetch function from useAuth()
 * @param {string} options.entityType - 'user' or 'group'
 * @param {string} options.listEndpoint - API endpoint for entity list (e.g., '/api/users')
 * @param {string} options.columnsEndpoint - API endpoint for column discovery
 * @param {string} options.tagFilterKey - Key for tag filter (e.g., '__userTag' or '__groupTag')
 * @param {object} [options.baseFilters] - Page-level filters always applied on top of user-driven ones
 *   (e.g. the Users-page principalType sub-tab). Keys with null/empty values are dropped.
 *   The caller is expected to memoise this object so its identity is stable per intended value.
 */
export default function useEntityPage({ authFetch, entityType, listEndpoint, columnsEndpoint, tagFilterKey, baseFilters }) {
  const dialog = useDialog();
  // Filter/search/sort state is persisted per entity type so it survives the
  // list page unmounting when a result is opened in a detail tab and remounting
  // when the user comes back (issue #192). `entityType` is stable for the life
  // of the page, so these keys are stable across renders.
  const skey = (k) => (entityType ? `iatlas.list.${entityType}.${k}` : null);
  // Data state
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [tags, setTags] = useState([]);
  // loading is flipped synchronously inside fetchItems; a reducer dispatch keeps
  // that clear of set-state-in-effect.
  const [loading, setLoading] = useReducer((_, v) => v, true);

  // Column discovery for filters
  const [availableColumns, setAvailableColumns] = useState([]);
  const [columnsLoading, setColumnsLoading] = useState(true);
  const [activeFilters, setActiveFilters] = usePersistedState(skey('filters'), []);

  // Filter state
  const [search, setSearch] = usePersistedState(skey('search'), '');
  const debouncedSearch = useDebouncedValue(search, 400);
  // Page resets to 0 on return — the persisted filters/search are what matter,
  // and starting at page 1 avoids landing on a now-empty page if the data moved.
  const [page, setPage] = useState(0);
  // Soft-deleted (tombstoned) entities are hidden by default; this reveals them.
  const [includeDeleted, setIncludeDeleted] = usePersistedState(skey('includeDeleted'), false);

  // Selection state (transient — never persisted)
  const [selected, setSelected] = useState(new Set());

  // Sort state
  const [sortCol, setSortCol] = usePersistedState(skey('sortCol'), null);
  const [sortDir, setSortDir] = usePersistedState(skey('sortDir'), 'asc');

  // Tag creation state
  const [showCreateTag, setShowCreateTag] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState('#3b82f6');

  // Action state
  const [actionTag, setActionTag] = useState('');
  const [busy, setBusy] = useState(false);

  const fetchVersion = useRef(0);

  // Reset page & selection when filters change — during render via a
  // value-signature compare, so no synchronous setState lives in an effect.
  const filterResetSig = JSON.stringify({ debouncedSearch, activeFilters, baseFilters, includeDeleted });
  const [seenFilterResetSig, setSeenFilterResetSig] = useState(filterResetSig);
  if (filterResetSig !== seenFilterResetSig) {
    setSeenFilterResetSig(filterResetSig);
    setPage(0);
    setSelected(new Set());
  }

  // Fetch available columns for filter dropdowns
  useEffect(() => {
    (async () => {
      try {
        const res = await authFetch(columnsEndpoint);
        if (res.ok) setAvailableColumns(await res.json());
      } catch (err) { console.error('Failed to fetch columns:', err); }
      setColumnsLoading(false);
    })();
  }, [authFetch, columnsEndpoint]);

  // Fetch tags
  const fetchTags = useCallback(() => {
    return authFetch(`/api/tags?entityType=${entityType}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data) setTags(data); })
      .catch((err) => console.error('Failed to fetch tags:', err));
  }, [authFetch, entityType]);

  useEffect(() => { fetchTags(); }, [fetchTags]);

  // Build filters object for API: merge user-driven `activeFilters` on top
  // of page-level `baseFilters` (e.g. the Users-page principalType tab). User
  // filters win on key collision — tabs aren't expected to overlap with
  // user-configurable fields, but if they do, the explicit action wins.
  const filtersObj = useMemo(() => {
    const base = Object.fromEntries(
      Object.entries(baseFilters || {}).filter(([, v]) => v != null && v !== '')
    );
    const fromActive = Object.fromEntries(activeFilters.map(f => [f.field, f.value]));
    const merged = { ...base, ...fromActive };
    return Object.keys(merged).length ? merged : null;
  }, [activeFilters, baseFilters]);

  // Fetch items
  const fetchItems = useCallback(() => {
    const version = ++fetchVersion.current;
    setLoading(true);
    const params = new URLSearchParams({ limit: PAGE_SIZE, offset: page * PAGE_SIZE });
    if (debouncedSearch) params.set('search', debouncedSearch);
    if (filtersObj) params.set('filters', JSON.stringify(filtersObj));
    if (includeDeleted) params.set('includeDeleted', 'true');
    return authFetch(`${listEndpoint}?${params}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (json && version === fetchVersion.current) {
          setItems(json.data);
          // The list endpoints only return `total` on the first page (offset 0)
          // and send `total: null` on later pages to skip a redundant COUNT (the
          // Excel export reads the count once and then pages by row count). The
          // total doesn't change while paging, so keep the known value instead of
          // clobbering it with null — otherwise the pager/header crash on
          // `null.toLocaleString()` the moment you click Next.
          if (json.total != null) setTotal(json.total);
        }
      })
      .catch((err) => console.error(`Failed to fetch ${entityType}s:`, err))
      .finally(() => { if (version === fetchVersion.current) setLoading(false); });
  }, [page, debouncedSearch, filtersObj, authFetch, listEndpoint, includeDeleted, entityType]);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  // Selection helpers
  const toggleSelect = (id) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selected.size === items.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(items.map(i => i.id)));
    }
  };

  // Sort helpers
  const toggleSort = (col) => {
    if (sortCol === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortCol(col);
      setSortDir('asc');
    }
  };

  const sortedItems = useMemo(() => {
    if (!sortCol) return items;
    return [...items].sort((a, b) => {
      const av = (a[sortCol] ?? '').toString().toLowerCase();
      const bv = (b[sortCol] ?? '').toString().toLowerCase();
      const cmp = av.localeCompare(bv);
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [items, sortCol, sortDir]);

  // Filter helpers
  const addFilter = useCallback((field, value) => {
    setActiveFilters(prev => [...prev.filter(f => f.field !== field), { field, value }]);
  }, [setActiveFilters]);

  const removeFilter = useCallback((field) => {
    setActiveFilters(prev => prev.filter(f => f.field !== field));
  }, [setActiveFilters]);

  const clearAllFilters = () => {
    setActiveFilters([]);
    setSearch('');
  };

  // Active tag filter
  const activeTagFilter = activeFilters.find(f => f.field === tagFilterKey)?.value || '';

  // Tag operations
  const createTag = async () => {
    if (!newTagName.trim()) return;
    setBusy(true);
    try {
      const res = await authFetch('/api/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newTagName.trim(), color: newTagColor, entityType }),
      });
      if (res.ok) {
        setNewTagName('');
        setShowCreateTag(false);
        await fetchTags();
      } else {
        const err = await res.json().catch(() => ({}));
        dialog.alert(err.error || 'Failed to create tag');
      }
    } finally { setBusy(false); }
  };

  const assignTag = async () => {
    if (!actionTag || selected.size === 0) return;
    setBusy(true);
    try {
      await authFetch(`/api/tags/${actionTag}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityIds: [...selected] }),
      });
      setActionTag('');
      await Promise.all([fetchItems(), fetchTags()]);
    } finally { setBusy(false); }
  };

  const assignTagToAll = async () => {
    if (!actionTag) return;
    setBusy(true);
    try {
      const res = await authFetch(`/api/tags/${actionTag}/assign-by-filter`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entityType,
          search: debouncedSearch || undefined,
          filters: filtersObj || undefined,
        }),
      });
      if (res.ok) {
        const json = await res.json();
        dialog.toast(`Tagged ${json.inserted} ${entityType}s`, { variant: 'success' });
      }
      setActionTag('');
      await Promise.all([fetchItems(), fetchTags()]);
    } finally { setBusy(false); }
  };

  const removeTagFromSelected = async () => {
    if (!actionTag || selected.size === 0) return;
    setBusy(true);
    try {
      await authFetch(`/api/tags/${actionTag}/unassign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityIds: [...selected] }),
      });
      setActionTag('');
      await Promise.all([fetchItems(), fetchTags()]);
    } finally { setBusy(false); }
  };

  const deleteTag = async (tagId) => {
    if (!(await dialog.confirm({ message: 'Delete this tag and all its assignments?', confirmLabel: 'Delete', danger: true }))) return;
    setBusy(true);
    try {
      await authFetch(`/api/tags/${tagId}`, { method: 'DELETE' });
      const deletedTag = tags.find(t => t.id === tagId);
      if (deletedTag && activeTagFilter === deletedTag.name) {
        removeFilter(tagFilterKey);
      }
      await Promise.all([fetchTags(), fetchItems()]);
    } finally { setBusy(false); }
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const allOnPageSelected = items.length > 0 && selected.size === items.length;
  const hasAnyFilter = activeFilters.length > 0 || debouncedSearch;

  // Build filterFields from availableColumns. Keys that start with `ext.`
  // are extended-attribute filters (see api columnCache.js / buildFilterWhere)
  // — we strip the prefix for display and tag the label with "(ext)" so
  // they're visually distinct from real columns in the dropdown.
  const getFilterFields = useCallback((fieldLabels) => {
    const humanize = (s) => s.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()).trim();
    return availableColumns
      .filter(col => col.values && col.values.length >= 1 && col.values.length <= 500)
      .map(col => {
        if (fieldLabels[col.column]) {
          return { key: col.column, label: fieldLabels[col.column] };
        }
        if (col.column.startsWith('ext.')) {
          return { key: col.column, label: `${humanize(col.column.slice(4))} (ext)` };
        }
        return { key: col.column, label: humanize(col.column) };
      });
  }, [availableColumns]);

  const getOptionsForField = useCallback((fieldKey) => {
    const col = availableColumns.find(c => c.column === fieldKey);
    return col?.values || [];
  }, [availableColumns]);

  return {
    // Data
    items, total, tags, loading, sortedItems,
    // Pagination
    page, setPage, totalPages, PAGE_SIZE,
    // Search & Filters
    search, setSearch, debouncedSearch,
    includeDeleted, setIncludeDeleted,
    activeFilters, addFilter, removeFilter, clearAllFilters,
    hasAnyFilter, activeTagFilter, filtersObj,
    columnsLoading, getFilterFields, getOptionsForField,
    // Selection
    selected, setSelected, toggleSelect, toggleSelectAll, allOnPageSelected,
    // Sort
    sortCol, sortDir, toggleSort,
    // Tag creation
    showCreateTag, setShowCreateTag, newTagName, setNewTagName, newTagColor, setNewTagColor,
    // Tag operations
    createTag, assignTag, assignTagToAll, removeTagFromSelected, deleteTag,
    actionTag, setActionTag, busy,
    // Refresh
    fetchItems, fetchTags,
  };
}
