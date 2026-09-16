import { useState, useEffect, useReducer, useCallback, useMemo, useRef } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useCanExportUi } from '@ui/auth/usePermissions';
import { TAG_COLORS } from '@ui/utils/colors';
import { useIsDark } from '@ui/contexts/ThemeContext';
import { useDebouncedValue } from '@ui/hooks/useDebouncedValue';
import { useDialog } from '@ui/components/dialogContext';
import AccessPackagesHeader from './accessPackages/AccessPackagesHeader';
import CategoryManagementBar from './accessPackages/CategoryManagementBar';
import CreateCategoryForm from './accessPackages/CreateCategoryForm';
import AccessPackagesFilterBar from './accessPackages/AccessPackagesFilterBar';
import SelectionActionBar from './accessPackages/SelectionActionBar';
import AccessPackagesTable from './accessPackages/AccessPackagesTable';
import AccessPackagesPagination from './accessPackages/AccessPackagesPagination';

const PAGE_SIZE = 100;

export default function AccessPackagesPage({ onOpenDetail }) {
  const { authFetch } = useAuth();
  const isDark = useIsDark();
  const dialog = useDialog();
  const canExport = useCanExportUi();

  // Data state
  const [packages, setPackages] = useState([]);
  const [total, setTotal] = useState(0);
  const [categories, setCategories] = useState([]);
  // loading is flipped synchronously inside fetchPackages; a reducer dispatch
  // (not a useState setter) keeps that clear of set-state-in-effect.
  const [loading, setLoading] = useReducer((_, v) => v, true);

  // Filter state
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 400);
  const [page, setPage] = useState(0);
  const [categoryFilter, setCategoryFilter] = useState(null); // null = all, number = categoryId, 'uncategorized' = no category
  const [typeFilter, setTypeFilter] = useState(null); // null = all, string = assignment type

  // Selection state
  const [selected, setSelected] = useState(new Set());

  // Sort state
  const [sortCol, setSortCol] = useState(null);
  const [sortDir, setSortDir] = useState('asc');

  // Category creation state
  const [showCreateCategory, setShowCreateCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [newCategoryColor, setNewCategoryColor] = useState(TAG_COLORS[0]);

  // Action state
  const [actionCategory, setActionCategory] = useState('');
  const [busy, setBusy] = useState(false);

  // Export state
  const [exportStatus, setExportStatus] = useState(null); // null | string message

  const fetchVersion = useRef(0);


  // Reset page & selection when filters or sort change — during render via a
  // composite-signature compare, so no synchronous setState lives in an effect.
  const apFilterSig = `${debouncedSearch}|${categoryFilter}|${typeFilter}|${sortCol}|${sortDir}`;
  const [seenApFilterSig, setSeenApFilterSig] = useState(apFilterSig);
  if (apFilterSig !== seenApFilterSig) {
    setSeenApFilterSig(apFilterSig);
    setPage(0);
    setSelected(new Set());
  }

  // Fetch categories — .then() chain so setCategories runs in the callback.
  const fetchCategories = useCallback(() => {
    return authFetch('/api/categories')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data) setCategories(data); })
      .catch((err) => console.error('Failed to fetch categories:', err));
  }, [authFetch]);

  useEffect(() => { fetchCategories(); }, [fetchCategories]);

  // Fetch access packages — loading flips via reducer; data setStates run in the
  // .then() callback. fetchVersion guards against out-of-order responses.
  const fetchPackages = useCallback(() => {
    const version = ++fetchVersion.current;
    setLoading(true);
    const params = new URLSearchParams({ limit: PAGE_SIZE, offset: page * PAGE_SIZE });
    if (debouncedSearch) params.set('search', debouncedSearch);
    if (categoryFilter !== null) {
      if (categoryFilter === 'uncategorized') {
        params.set('uncategorized', 'true');
      } else {
        params.set('categoryId', categoryFilter);
      }
    }
    if (sortCol) {
      params.set('sortCol', sortCol);
      params.set('sortDir', sortDir);
    }
    return authFetch(`/api/access-packages?${params}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (json && version === fetchVersion.current) {
          setPackages(json.data);
          setTotal(json.total);
        }
      })
      .catch((err) => console.error('Failed to fetch access packages:', err))
      .finally(() => { if (version === fetchVersion.current) setLoading(false); });
  }, [page, debouncedSearch, categoryFilter, sortCol, sortDir, authFetch]);

  useEffect(() => { fetchPackages(); }, [fetchPackages]);

  // Selection helpers
  const toggleSelect = (id) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selected.size === packages.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(packages.map(p => p.id)));
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

  // Apply client-side type filter only (sorting is server-side)
  const sortedPackages = useMemo(() => {
    if (!typeFilter) return packages;
    return packages.filter(p => p.assignmentType === typeFilter);
  }, [packages, typeFilter]);

  // Category operations
  const createCategory = async () => {
    if (!newCategoryName.trim()) return;
    setBusy(true);
    try {
      const res = await authFetch('/api/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newCategoryName.trim(), color: newCategoryColor }),
      });
      if (res.ok) {
        setNewCategoryName('');
        setShowCreateCategory(false);
        await fetchCategories();
      } else {
        const err = await res.json().catch(() => ({}));
        dialog.alert(err.error || 'Failed to create category');
      }
    } finally { setBusy(false); }
  };

  const assignCategory = async () => {
    if (!actionCategory || selected.size === 0) return;
    setBusy(true);
    try {
      for (const apId of selected) {
        await authFetch(`/api/categories/${actionCategory}/assign`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resourceId: apId }),
        });
      }
      setActionCategory('');
      await Promise.all([fetchPackages(), fetchCategories()]);
    } finally { setBusy(false); }
  };

  const removeCategoryFromSelected = async () => {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      for (const apId of selected) {
        await authFetch('/api/categories/unassign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resourceId: apId }),
        });
      }
      await Promise.all([fetchPackages(), fetchCategories()]);
    } finally { setBusy(false); }
  };

  const deleteCategory = async (catId) => {
    if (!(await dialog.confirm({ message: 'Delete this category and all its assignments?', confirmLabel: 'Delete', danger: true }))) return;
    setBusy(true);
    try {
      await authFetch(`/api/categories/${catId}`, { method: 'DELETE' });
      if (categoryFilter === catId) setCategoryFilter(null);
      await Promise.all([fetchCategories(), fetchPackages()]);
    } finally { setBusy(false); }
  };

  // Quick-assign category from dropdown in table row
  const assignCategoryToOne = async (apId, catId) => {
    setBusy(true);
    try {
      if (catId) {
        await authFetch(`/api/categories/${catId}/assign`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resourceId: apId }),
        });
      } else {
        await authFetch('/api/categories/unassign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resourceId: apId }),
        });
      }
      await Promise.all([fetchPackages(), fetchCategories()]);
    } finally { setBusy(false); }
  };

  const handleExportExcel = useCallback(async () => {
    setExportStatus('Fetching business roles...');
    try {
      const { exportAccessPackagesToExcel } = await import('../utils/exportAccessPackagesToExcel');
      await exportAccessPackagesToExcel({
        authFetch,
        search: debouncedSearch,
        categoryFilter,
        sortCol,
        sortDir,
        typeFilter,
        onProgress: setExportStatus,
      });
    } catch (err) {
      console.error('Export failed:', err);
    } finally {
      setExportStatus(null);
    }
  }, [authFetch, debouncedSearch, categoryFilter, sortCol, sortDir, typeFilter]);

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const allOnPageSelected = packages.length > 0 && selected.size === packages.length;
  const hasAnyFilter = categoryFilter !== null || typeFilter !== null || debouncedSearch;

  return (
    <div className="max-w-7xl mx-auto">
      <AccessPackagesHeader
        total={total}
        canExport={canExport}
        exportStatus={exportStatus}
        onExport={handleExportExcel}
      />

      <CategoryManagementBar
        categories={categories}
        categoryFilter={categoryFilter}
        setCategoryFilter={setCategoryFilter}
        isDark={isDark}
        onDelete={deleteCategory}
        onToggleCreate={() => setShowCreateCategory(!showCreateCategory)}
      />

      {showCreateCategory && (
        <CreateCategoryForm
          name={newCategoryName}
          setName={setNewCategoryName}
          color={newCategoryColor}
          setColor={setNewCategoryColor}
          onCreate={createCategory}
          onCancel={() => setShowCreateCategory(false)}
          busy={busy}
        />
      )}

      <AccessPackagesFilterBar
        search={search}
        setSearch={setSearch}
        typeFilter={typeFilter}
        setTypeFilter={setTypeFilter}
        hasAnyFilter={hasAnyFilter}
        onClearAll={() => { setCategoryFilter(null); setTypeFilter(null); setSearch(''); }}
      />

      <SelectionActionBar
        selectedCount={selected.size}
        categories={categories}
        actionCategory={actionCategory}
        setActionCategory={setActionCategory}
        onAssign={assignCategory}
        onRemove={removeCategoryFromSelected}
        onClear={() => setSelected(new Set())}
        busy={busy}
      />

      {/* Table */}
      {loading ? (
        <div className="text-center text-gray-500 dark:text-gray-400 py-12">Loading business roles...</div>
      ) : packages.length === 0 ? (
        <div className="text-center text-gray-500 dark:text-gray-400 py-12">
          {hasAnyFilter ? 'No business roles match the current filters.' : 'No business roles found.'}
        </div>
      ) : (
        <AccessPackagesTable
          packages={sortedPackages}
          categories={categories}
          selected={selected}
          allOnPageSelected={allOnPageSelected}
          sortCol={sortCol}
          sortDir={sortDir}
          busy={busy}
          isDark={isDark}
          onToggleSelectAll={toggleSelectAll}
          onToggleSort={toggleSort}
          onToggleSelect={toggleSelect}
          onOpenDetail={onOpenDetail}
          onAssignCategoryToOne={assignCategoryToOne}
        />
      )}

      <AccessPackagesPagination
        page={page}
        setPage={setPage}
        totalPages={totalPages}
        total={total}
        pageSize={PAGE_SIZE}
      />
    </div>
  );
}
