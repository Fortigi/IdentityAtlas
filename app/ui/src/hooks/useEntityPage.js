import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useDebouncedValue } from './useDebouncedValue';

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
 */
export default function useEntityPage({ authFetch, entityType, listEndpoint, columnsEndpoint, tagFilterKey }) {
  // Data state
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [tags, setTags] = useState([]);
  const [loading, setLoading] = useState(true);

  // Column discovery for filters
  const [availableColumns, setAvailableColumns] = useState([]);
  const [columnsLoading, setColumnsLoading] = useState(true);
  const [activeFilters, setActiveFilters] = useState([]);

  // Filter state
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 400);
  const [page, setPage] = useState(0);

  // Selection state
  const [selected, setSelected] = useState(new Set());

  // Sort state
  const [sortCol, setSortCol] = useState(null);
  const [sortDir, setSortDir] = useState('asc');

  // Tag creation state
  const [showCreateTag, setShowCreateTag] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState('#3b82f6');

  // Action state
  const [actionTag, setActionTag] = useState('');
  const [busy, setBusy] = useState(false);

  const fetchVersion = useRef(0);

  // Reset page & selection when filters change
  useEffect(() => { setPage(0); setSelected(new Set()); }, [debouncedSearch, activeFilters]);

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
  const fetchTags = useCallback(async () => {
    try {
      const res = await authFetch(`/api/tags?entityType=${entityType}`);
      if (res.ok) setTags(await res.json());
    } catch (err) { console.error('Failed to fetch tags:', err); }
  }, [authFetch, entityType]);

  useEffect(() => { fetchTags(); }, [fetchTags]);

  // Build filters object for API
  const filtersObj = useMemo(() => {
    if (activeFilters.length === 0) return null;
    return Object.fromEntries(activeFilters.map(f => [f.field, f.value]));
  }, [activeFilters]);

  // Fetch items
  const fetchItems = useCallback(async () => {
    const version = ++fetchVersion.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: PAGE_SIZE, offset: page * PAGE_SIZE });
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (filtersObj) params.set('filters', JSON.stringify(filtersObj));
      const res = await authFetch(`${listEndpoint}?${params}`);
      if (res.ok && version === fetchVersion.current) {
        const json = await res.json();
        setItems(json.data);
        setTotal(json.total);
      }
    } catch (err) { console.error(`Failed to fetch ${entityType}s:`, err); }
    if (version === fetchVersion.current) setLoading(false);
  }, [page, debouncedSearch, filtersObj, authFetch, listEndpoint]);

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
  }, []);

  const removeFilter = useCallback((field) => {
    setActiveFilters(prev => prev.filter(f => f.field !== field));
  }, []);

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
        alert(err.error || 'Failed to create tag');
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
        alert(`Tagged ${json.inserted} ${entityType}s`);
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
    if (!confirm('Delete this tag and all its assignments?')) return;
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

  // Build filterFields from availableColumns
  const getFilterFields = useCallback((fieldLabels) => {
    return availableColumns
      .filter(col => col.values && col.values.length >= 1 && col.values.length <= 500)
      .map(col => ({
        key: col.column,
        label: fieldLabels[col.column] || col.column.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim(),
      }));
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
