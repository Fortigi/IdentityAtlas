import { useState } from 'react';
import { useCanExportUi } from '@ui/auth/usePermissions';

// Simplified Matrix toolbar (post-wizard redesign).
//
//   - Row selection / filtering happens in MatrixFilterWizard.
//   - The toolbar keeps only "view-time" controls: Governed/Non-governed/Gaps
//     toggle (formerly SOLL/IST), Excel export, Share link.
//   - "Adjust filter" re-opens the wizard.
//   - Search, user-limit slider, attribute/context FilterBars are gone.

export default function MatrixToolbar({
  managedFilter,
  setManagedFilter,
  onExportExcel,
  onShare,
  onResetRowOrder,
  hasCustomRowOrder,
  hasExpandableGroups,
  hasExpandedGroups,
  onExpandAll,
  onCollapseAll,
  canFoldColumns = false,
  isFolded = false,
  onFoldAllColumns,
  onUnfoldAllColumns,
  canFoldRoles = false,
  hasFoldedRoles = false,
  onFoldAllRoles,
  onUnfoldAllRoles,
  hideGaps = false,
}) {
  const [copied, setCopied] = useState(false);
  const canExport = useCanExportUi();

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {/* Governed / Non-governed / Gaps */}
      <div className="inline-flex rounded border border-gray-300 dark:border-gray-600 overflow-hidden">
        {[
          { key: 'all',       label: 'All' },
          { key: 'managed',   label: 'Governed' },
          { key: 'unmanaged', label: 'Non-governed' },
          ...(hideGaps ? [] : [{ key: 'gaps', label: 'Gaps' }]),
        ].map(opt => (
          <button
            key={opt.key}
            onClick={() => setManagedFilter(opt.key)}
            className={`px-2 py-1 text-xs font-medium transition-colors ${
              managedFilter === opt.key
                ? 'bg-blue-600 text-white'
                : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <div className="border-l border-gray-300 dark:border-gray-600 h-5 mx-1" />

      {canExport && (
        <button
          onClick={onExportExcel}
          className="px-2 py-1 rounded text-xs text-white bg-green-700 hover:bg-green-800 border border-green-800 font-medium"
          title="Export matrix to Excel (.xlsx)"
        >
          Export Excel
        </button>
      )}

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
            ? 'bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400 border-green-300 dark:border-green-700'
            : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 border-gray-200 dark:border-gray-600'
        }`}
        title="Copy shareable link to clipboard"
      >
        {copied ? 'Copied!' : 'Share Link'}
      </button>

      {hasCustomRowOrder && (
        <>
          <div className="border-l border-gray-300 dark:border-gray-600 h-5 mx-1" />
          <button
            onClick={onResetRowOrder}
            className="px-2 py-1 rounded text-xs text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 border border-gray-200 dark:border-gray-600"
            title="Reset row order to default"
          >
            Reset Rows
          </button>
        </>
      )}

      {hasExpandableGroups && (
        <>
          <div className="border-l border-gray-300 dark:border-gray-600 h-5 mx-1" />
          <button
            onClick={onExpandAll}
            className="px-2 py-1 rounded text-xs text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 border border-gray-200 dark:border-gray-600"
            title="Expand all nested groups (up to 4 levels)"
          >
            Expand All
          </button>
          {hasExpandedGroups && (
            <button
              onClick={onCollapseAll}
              className="px-2 py-1 rounded text-xs text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 border border-gray-200 dark:border-gray-600"
              title="Collapse all nested groups"
            >
              Collapse All
            </button>
          )}
        </>
      )}

      {/* Fold/unfold the sort-attribute columns into aggregate count columns */}
      {canFoldColumns && (
        <>
          <div className="border-l border-gray-300 dark:border-gray-600 h-5 mx-1" />
          <button
            onClick={onFoldAllColumns}
            className="px-2 py-1 rounded text-xs text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 border border-indigo-200 dark:border-indigo-700"
            title="Fold every top-level group into a single count column"
          >
            Fold columns
          </button>
          {isFolded && (
            <button
              onClick={onUnfoldAllColumns}
              className="px-2 py-1 rounded text-xs text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 border border-gray-200 dark:border-gray-600"
              title="Unfold all columns back to individual subjects"
            >
              Unfold columns
            </button>
          )}
        </>
      )}

      {/* Fold the resources a business role grants into the role's own row */}
      {canFoldRoles && (
        <>
          <div className="border-l border-gray-300 dark:border-gray-600 h-5 mx-1" />
          <button
            onClick={onFoldAllRoles}
            className="px-2 py-1 rounded text-xs text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 border border-indigo-200 dark:border-indigo-700"
            title="Fold every business role — leaves only business roles and resources no role grants"
          >
            Fold roles
          </button>
          {hasFoldedRoles && (
            <button
              onClick={onUnfoldAllRoles}
              className="px-2 py-1 rounded text-xs text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 border border-gray-200 dark:border-gray-600"
              title="Unfold all business roles and show their resources again"
            >
              Unfold roles
            </button>
          )}
        </>
      )}

    </div>
  );
}
