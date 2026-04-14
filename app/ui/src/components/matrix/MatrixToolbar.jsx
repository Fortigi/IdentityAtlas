import { useState } from 'react';
import FilterBar from '../FilterBar';

export default function MatrixToolbar({
  filterFields,
  userFilterFields,
  activeFilters,
  getOptionsForField,
  onAddFilter,
  onRemoveFilter,
  filterText,
  setFilterText,
  managedFilter,
  setManagedFilter,
  userLimit,
  setUserLimit,
  onExportExcel,
  onShare,
  onResetRowOrder,
  hasCustomRowOrder,
  stats,
  hasExpandableGroups,
  hasExpandedGroups,
  onExpandAll,
  onCollapseAll,
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      {/* Row 1: User filters + search + user limit slider */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <FilterBar
          label="User Filters:"
          filterFields={userFilterFields}
          activeFilters={activeFilters}
          getOptionsForField={getOptionsForField}
          onAddFilter={onAddFilter}
          onRemoveFilter={onRemoveFilter}
        />

        <div className="border-l border-gray-300 h-5 mx-1" />

        <input
          type="text"
          value={filterText}
          onChange={e => setFilterText(e.target.value)}
          placeholder="Search users or resources..."
          className="px-2 py-1 border border-gray-300 rounded text-xs w-44"
        />

        <div className="border-l border-gray-300 h-5 mx-1" />

        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-600 whitespace-nowrap">Users:</label>
          <input
            type="range"
            min={5}
            max={stats.totalUsers}
            step={1}
            value={userLimit <= 0 ? stats.totalUsers : Math.min(userLimit, stats.totalUsers)}
            onChange={e => {
              const val = Number(e.target.value);
              setUserLimit(val >= stats.totalUsers ? 0 : val);
            }}
            className="w-24 h-1 accent-blue-600"
          />
          <button
            onClick={() => setUserLimit(userLimit <= 0 ? 25 : 0)}
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium border transition-colors ${
              userLimit <= 0
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-white text-gray-500 border-gray-300 hover:bg-gray-50'
            }`}
            title={userLimit <= 0 ? 'Click to limit to 25 users' : 'Click to show all users'}
          >
            All
          </button>
          <span className="text-xs text-gray-700 font-medium tabular-nums w-8 text-right">
            {userLimit <= 0 ? stats.totalUsers : Math.min(userLimit, stats.totalUsers)}
          </span>
        </div>

        <div className="text-xs text-gray-500 ml-auto">
          {stats.users < stats.totalUsers ? (
            <span className="text-amber-600 font-medium" title={
              userLimit > 0 && stats.users >= userLimit
                ? `Slider limits to ${userLimit} users`
                : `${stats.totalUsers - stats.users} users have no assignments and are not shown`
            }>
              Showing {stats.users} of {stats.totalUsers} users
              {(userLimit <= 0 || stats.users < userLimit) && <> ({stats.totalUsers - stats.users} have no assignments)</>}
            </span>
          ) : (
            <>{stats.users} users</>
          )}
          {' '}&times; {stats.groups} resources &middot; {stats.memberships} assignments
        </div>
      </div>

      {/* Row 2: Managed toggle + actions */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <div className="inline-flex rounded border border-gray-300 overflow-hidden">
          {[
            { key: 'all',       label: 'All' },
            { key: 'unmanaged', label: 'Unmanaged' },
            { key: 'managed',   label: 'Managed' },
            { key: 'gaps',      label: 'Gaps' },
          ].map(opt => (
            <button
              key={opt.key}
              onClick={() => setManagedFilter(opt.key)}
              className={`px-2 py-1 text-xs font-medium transition-colors ${
                managedFilter === opt.key
                  ? 'bg-blue-600 text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div className="border-l border-gray-300 h-5 mx-1" />

        <button
          onClick={onExportExcel}
          className="px-2 py-1 rounded text-xs text-white bg-green-600 hover:bg-green-700 border border-green-700 font-medium"
          title="Export matrix to Excel (.xlsx)"
        >
          Export Excel
        </button>

        <button
          onClick={async () => {
            const ok = await onShare();
            if (ok) {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }
          }}
          className={`px-2 py-1 rounded text-xs font-medium border transition-colors ${
            copied
              ? 'bg-green-50 text-green-700 border-green-300'
              : 'text-gray-600 hover:bg-gray-100 border-gray-200'
          }`}
          title="Copy shareable link to clipboard"
        >
          {copied ? 'Copied!' : 'Share Link'}
        </button>

        {hasCustomRowOrder && (
          <>
            <div className="border-l border-gray-300 h-5 mx-1" />
            <button
              onClick={onResetRowOrder}
              className="px-2 py-1 rounded text-xs text-gray-600 hover:bg-gray-100 border border-gray-200"
              title="Reset row order to default"
            >
              Reset Rows
            </button>
          </>
        )}

        {hasExpandableGroups && (
          <>
            <div className="border-l border-gray-300 h-5 mx-1" />
            <button
              onClick={onExpandAll}
              className="px-2 py-1 rounded text-xs text-gray-600 hover:bg-gray-100 border border-gray-200"
              title="Expand all nested groups (up to 4 levels)"
            >
              Expand All
            </button>
            {hasExpandedGroups && (
              <button
                onClick={onCollapseAll}
                className="px-2 py-1 rounded text-xs text-gray-600 hover:bg-gray-100 border border-gray-200"
                title="Collapse all nested groups"
              >
                Collapse All
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
