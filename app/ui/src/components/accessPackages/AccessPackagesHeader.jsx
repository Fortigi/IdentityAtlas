// Page header: title, total count, and the Excel export button (permission-gated).
export default function AccessPackagesHeader({ total, canExport, exportStatus, onExport }) {
  return (
    <div className="flex items-center gap-4 mb-4">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Business Roles</h2>
      <span className="text-sm text-gray-500 dark:text-gray-400">{total.toLocaleString()} total</span>
      {canExport && (
        <button
          onClick={onExport}
          disabled={!!exportStatus}
          className="ml-auto px-3 py-1 rounded text-xs text-white bg-green-700 hover:bg-green-800 border border-green-800 font-medium disabled:opacity-50"
          title="Export business roles to Excel (.xlsx)"
        >
          {exportStatus ? exportStatus : 'Export Excel'}
        </button>
      )}
    </div>
  );
}
