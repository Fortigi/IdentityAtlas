// Prev/Next pager over a client-held list. Renders nothing on a single page.
//
// Shared: the Business Roles list and the Reports table both hold their whole
// result set in memory and page it locally, and a second copy of this would be
// the third file in the repo drawing the same three controls.
export default function Pagination({ page, setPage, totalPages, total, pageSize }) {
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
