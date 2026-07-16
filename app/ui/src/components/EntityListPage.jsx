import { useMemo } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import useEntityPage from '@ui/hooks/useEntityPage';
import FilterBar from './FilterBar';
import { TAG_COLORS } from '@ui/utils/colors';

/**
 * Shared scaffold for Resources, Users, and Identities list pages.
 *
 * Props:
 *   title, entityType, listEndpoint, columnsEndpoint, tagFilterKey
 *   tableColumns        [{key, label}] — sortable header columns (entity name + tags are added automatically)
 *   fieldLabels         {column: 'Human Label'} — passed to getFilterFields
 *   renderEntityCell    (item, onOpenDetail) => <td> — the entity-name link cell
 *   renderDataCells     (item) => <td>…</td> — data cells between entity name and tags
 *   searchPlaceholder   string
 *   showIncludeDeleted  boolean (default false)
 *   subTabBar           JSX rendered between header and tag bar (optional)
 *   baseFilters         object passed to useEntityPage (optional, for sub-tab driven filters)
 *   customizeFilterFields  (fields) => fields — optional callback to filter/sort the filter dropdown
 *   onOpenDetail        (kind, id, name) => void
 */
export default function EntityListPage({
  title,
  entityType,
  listEndpoint,
  columnsEndpoint,
  tagFilterKey,
  tableColumns,
  fieldLabels,
  renderEntityCell,
  renderDataCells,
  searchPlaceholder,
  showIncludeDeleted = false,
  subTabBar = null,
  baseFilters = null,
  customizeFilterFields = null,
  onOpenDetail,
}) {
  const { authFetch } = useAuth();

  const ep = useEntityPage({
    authFetch,
    entityType,
    listEndpoint,
    columnsEndpoint,
    tagFilterKey,
    baseFilters,
  });

  const filterFields = useMemo(() => {
    const fields = ep.getFilterFields(fieldLabels);
    return customizeFilterFields ? customizeFilterFields(fields) : fields;
  }, [ep, fieldLabels, customizeFilterFields]);

  const label = title.toLowerCase();

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-4 mb-4">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h2>
        <span className="text-sm text-gray-500 dark:text-gray-400">{ep.total.toLocaleString()} total</span>
      </div>

      {subTabBar}

      {/* Tag management bar */}
      <div className="flex flex-wrap items-center gap-2 mb-3 text-sm">
        <span className="font-medium text-gray-600 dark:text-gray-400">Tags:</span>
        {ep.tags.map(t => (
          <span
            key={t.id}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium cursor-pointer border ${
              ep.activeTagFilter === t.name
                ? 'ring-2 ring-offset-1 ring-blue-400'
                : 'hover:opacity-80'
            }`}
            style={{ backgroundColor: t.color + '20', borderColor: t.color, color: t.color }}
            onClick={() => {
              if (ep.activeTagFilter === t.name) {
                ep.removeFilter(tagFilterKey);
              } else {
                ep.addFilter(tagFilterKey, t.name);
              }
            }}
            title={`${t.assignmentCount} ${label} tagged — click to filter`}
          >
            {t.name}
            <span className="text-[10px] opacity-70">({t.assignmentCount})</span>
            <button
              onClick={(e) => { e.stopPropagation(); ep.deleteTag(t.id); }}
              className="ml-0.5 hover:opacity-100 opacity-50"
              title="Delete tag"
            >
              &times;
            </button>
          </span>
        ))}
        <button
          onClick={() => ep.setShowCreateTag(!ep.showCreateTag)}
          className="px-2 py-0.5 rounded text-xs text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/30 border border-blue-200 dark:border-blue-700 border-dashed"
        >
          + New Tag
        </button>
      </div>

      {/* Create tag form */}
      {ep.showCreateTag && (
        <div className="flex items-center gap-2 mb-3 p-3 bg-gray-50 dark:bg-gray-700/50 border border-gray-200 dark:border-gray-700 rounded-lg text-sm">
          <input
            type="text"
            value={ep.newTagName}
            onChange={e => ep.setNewTagName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && ep.createTag()}
            placeholder="Tag name..."
            className="px-2 py-1 border border-gray-300 dark:border-gray-600 rounded text-sm w-48 dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500"
            autoFocus
          />
          <div className="flex items-center gap-1">
            {TAG_COLORS.map(c => (
              <button
                key={c}
                onClick={() => ep.setNewTagColor(c)}
                className={`w-5 h-5 rounded-full border-2 ${ep.newTagColor === c ? 'border-gray-800 scale-110' : 'border-transparent'}`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
          <button
            onClick={ep.createTag}
            disabled={!ep.newTagName.trim() || ep.busy}
            className="px-3 py-1 rounded text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
          >
            Create
          </button>
          <button
            onClick={() => ep.setShowCreateTag(false)}
            className="px-2 py-1 rounded text-sm text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Filter bar + search */}
      <div className="flex flex-wrap items-center gap-2 mb-3 text-sm">
        <FilterBar
          label="Filters:"
          filterFields={filterFields}
          activeFilters={ep.activeFilters}
          getOptionsForField={ep.getOptionsForField}
          onAddFilter={ep.addFilter}
          onRemoveFilter={ep.removeFilter}
          loading={ep.columnsLoading}
        />

        <div className="border-l border-gray-300 dark:border-gray-600 h-5 mx-1" />

        <input
          type="text"
          value={ep.search}
          onChange={e => ep.setSearch(e.target.value)}
          placeholder={searchPlaceholder}
          className="px-2 py-1 border border-gray-300 dark:border-gray-600 rounded text-xs w-64 dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500"
        />

        {showIncludeDeleted && (
          <label
            className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400 cursor-pointer select-none"
            title={`Also show ${label} that were deleted in the source system`}
          >
            <input type="checkbox" checked={ep.includeDeleted} onChange={e => ep.setIncludeDeleted(e.target.checked)} />
            Include deleted
          </label>
        )}

        {ep.hasAnyFilter && (
          <>
            <div className="border-l border-gray-300 dark:border-gray-600 h-5 mx-1" />
            <button
              onClick={ep.clearAllFilters}
              className="px-2 py-1 rounded text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 border border-gray-200 dark:border-gray-700"
            >
              Clear all
            </button>
          </>
        )}
      </div>

      {/* Action bar */}
      {ep.selected.size > 0 && (
        <div className="flex items-center gap-3 mb-3 p-2 bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-700 rounded-lg text-sm">
          <span className="font-medium text-blue-700 dark:text-blue-300">{ep.selected.size} selected</span>
          <div className="border-l border-blue-200 dark:border-blue-700 h-5" />
          <select
            value={ep.actionTag}
            onChange={e => ep.setActionTag(e.target.value)}
            className="px-2 py-1 border border-gray-300 dark:border-gray-600 rounded text-sm dark:bg-gray-700 dark:text-gray-200"
          >
            <option value="">Select tag...</option>
            {ep.tags.map(t => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          <button
            onClick={ep.assignTag}
            disabled={!ep.actionTag || ep.busy}
            className="px-3 py-1 rounded text-sm font-medium text-white bg-green-600 hover:bg-green-700 disabled:opacity-50"
          >
            Assign Tag
          </button>
          <button
            onClick={ep.removeTagFromSelected}
            disabled={!ep.actionTag || ep.busy}
            className="px-3 py-1 rounded text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 border border-red-200 dark:border-red-700 disabled:opacity-50"
          >
            Remove Tag
          </button>
          {ep.hasAnyFilter && ep.total > ep.selected.size && (
            <>
              <div className="border-l border-blue-200 dark:border-blue-700 h-5" />
              <button
                onClick={ep.assignTagToAll}
                disabled={!ep.actionTag || ep.busy}
                className="px-3 py-1 rounded text-sm font-medium text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/30 border border-blue-300 dark:border-blue-700 disabled:opacity-50"
                title={`Tag all ${ep.total} ${label} matching current filters`}
              >
                Tag all {ep.total} matching
              </button>
            </>
          )}
          <button
            onClick={() => ep.setSelected(new Set())}
            className="px-2 py-1 rounded text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 ml-auto"
          >
            Clear selection
          </button>
        </div>
      )}

      {/* Table */}
      <EntityListTable
        ep={ep}
        label={label}
        tableColumns={tableColumns}
        renderEntityCell={renderEntityCell}
        renderDataCells={renderDataCells}
        onOpenDetail={onOpenDetail}
      />

      {/* Pagination */}
      {ep.totalPages > 1 && (
        <div className="flex items-center justify-between mt-3 text-sm text-gray-600 dark:text-gray-400">
          <span>
            Showing {ep.page * ep.PAGE_SIZE + 1}&ndash;{Math.min((ep.page + 1) * ep.PAGE_SIZE, ep.total)} of {ep.total.toLocaleString()}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => ep.setPage(p => Math.max(0, p - 1))}
              disabled={ep.page === 0}
              className="px-3 py-1 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-40"
            >
              Prev
            </button>
            <span>Page {ep.page + 1} of {ep.totalPages}</span>
            <button
              onClick={() => ep.setPage(p => Math.min(ep.totalPages - 1, p + 1))}
              disabled={ep.page >= ep.totalPages - 1}
              className="px-3 py-1 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// The list body's four states (loading / error / empty / table) are their
// own component so EntityListPage's render stays under the complexity ceiling.
function EntityListTable({ ep, label, tableColumns, renderEntityCell, renderDataCells, onOpenDetail }) {
  return (
    ep.loading ? (
        <div className="text-center text-gray-500 dark:text-gray-400 py-12">Loading {label}...</div>
      ) : ep.error ? (
        <div className="text-center py-12" role="alert">
          <p className="text-red-700 dark:text-red-300 font-medium">Couldn&apos;t load {label}.</p>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            {ep.error.message || 'The request failed. Check your connection and try again.'}
          </p>
          <button
            onClick={ep.fetchItems}
            className="mt-4 px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700"
          >
            Retry
          </button>
        </div>
      ) : ep.items.length === 0 ? (
        <div className="text-center text-gray-500 dark:text-gray-400 py-12">
          {ep.hasAnyFilter ? `No ${label} match the current filters.` : `No ${label} found.`}
        </div>
      ) : (
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-700 border-b border-gray-200 dark:border-gray-700">
                <th className="w-10 px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label="Select all rows on this page"
                    checked={ep.allOnPageSelected}
                    onChange={ep.toggleSelectAll}
                    className="rounded"
                  />
                </th>
                {tableColumns.map(col => (
                  <th
                    key={col.key}
                    onClick={() => ep.toggleSort(col.key)}
                    className="text-left px-3 py-2 font-medium text-gray-700 dark:text-gray-300 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-700"
                  >
                    <span className="inline-flex items-center gap-1">
                      {col.label}
                      {ep.sortCol === col.key ? (
                        <span className="text-blue-600 text-[10px]">{ep.sortDir === 'asc' ? '▲' : '▼'}</span>
                      ) : (
                        <span className="text-gray-500 dark:text-gray-500 text-[10px]">{'▴'}</span>
                      )}
                    </span>
                  </th>
                ))}
                <th className="text-left px-3 py-2 font-medium text-gray-700 dark:text-gray-300">Tags</th>
              </tr>
            </thead>
            <tbody>
              {ep.sortedItems.map(item => (
                <tr
                  key={item.id}
                  className={`border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer ${
                    ep.selected.has(item.id) ? 'bg-blue-50 dark:bg-blue-900/30' : ''
                  }`}
                  onClick={() => ep.toggleSelect(item.id)}
                >
                  <td className="px-3 py-2 text-center" onClick={e => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${item.displayName || item.name || item.id}`}
                      checked={ep.selected.has(item.id)}
                      onChange={() => ep.toggleSelect(item.id)}
                      className="rounded"
                    />
                  </td>
                  {renderEntityCell(item, onOpenDetail)}
                  {renderDataCells(item)}
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {(item.tags || []).map(t => (
                        <span
                          key={t.id}
                          className="inline-block px-1.5 py-0.5 rounded-full text-[10px] font-medium border"
                          style={{ backgroundColor: t.color + '20', borderColor: t.color, color: t.color }}
                        >
                          {t.name}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
  );
}
