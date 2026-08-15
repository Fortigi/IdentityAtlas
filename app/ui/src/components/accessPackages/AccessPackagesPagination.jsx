// Prev/Next pager for the Business Roles list. Renders nothing on a single page.
export default function AccessPackagesPagination({ page, setPage, totalPages, total, pageSize }) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between mt-3 text-sm text-gray-600 dark:text-gray-400">
      <span>
        Showing {page * pageSize + 1}&ndash;{Math.min((page + 1) * pageSize, total)} of {total.toLocaleString()}
      </span>
      <div className="flex items-center gap-2">
        <button
          onClick={() => setPage(p => Math.max(0, p - 1))}
          disabled={page === 0}
          className="px-3 py-1 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-40"
        >
          Prev
        </button>
        <span>Page {page + 1} of {totalPages}</span>
        <button
          onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
          disabled={page >= totalPages - 1}
          className="px-3 py-1 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  );
}
