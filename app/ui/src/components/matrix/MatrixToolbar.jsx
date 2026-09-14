import { useCanExportUi } from '@ui/auth/usePermissions';
import { useIsSharedView } from '@ui/contexts/SharedViewContext';
import { usePopover } from './usePopover';

// The toolbar row above the matrix grid ("a matrix is a document", #1202).
//
// It carries only what changes the view of the whole document: the lens —
// All / Governed / Non-governed / Gaps — and Export. Controls that act on one
// axis of the grid (fold columns, expand/fold rows, reset row order, the
// legend) live in the grid's own header corner (GridCornerControls). Saving,
// loading and sharing live in the Load / Save / Share bar above. There is no
// "Copy link": sharing replaced it, and the URL still carries the matrix.

// Export ▾ — a small menu, so further formats have somewhere to go.
function ExportMenu({ onExportExcel }) {
  const { open, toggle, close, triggerRef, panelRef } = usePopover();
  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        className="rounded border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700 dark:focus-visible:ring-blue-400"
      >
        Export <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div ref={panelRef} role="menu" aria-label="Export"
          className="absolute right-0 top-full z-30 mt-1 min-w-[10rem] rounded border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-600 dark:bg-gray-800">
          <button
            type="button"
            role="menuitem"
            data-autofocus
            onClick={() => { close(); onExportExcel(); }}
            title="Export matrix to Excel (.xlsx)"
            className="block w-full px-3 py-1.5 text-left text-xs text-gray-800 hover:bg-gray-100 focus:bg-gray-100 focus:outline-none dark:text-gray-200 dark:hover:bg-gray-700 dark:focus:bg-gray-700"
          >
            Export Excel
          </button>
        </div>
      )}
    </div>
  );
}

export default function MatrixToolbar({ managedFilter, setManagedFilter, onExportExcel, hideGaps = false }) {
  // A recipient of a share link gets the matrix, not the analyst's tooling: no
  // export (#1166).
  const isSharedView = useIsSharedView();
  const canExport = useCanExportUi() && !isSharedView;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
      {/* The lens: All / Governed / Non-governed / Gaps */}
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

      {canExport && <ExportMenu onExportExcel={onExportExcel} />}
    </div>
  );
}
