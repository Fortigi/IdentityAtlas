// Modal explaining how an inherited (Indirect) access arose — the scope-hierarchy
// grant and the chain down to the subject. Rendered by MatrixView when the user
// clicks an I badge; extracted so the orchestrator stays focused on the grid.
// Renders nothing until there is a `pathExplain` payload to show.

export default function InheritancePathModal({ pathExplain, onClose }) {
  if (!pathExplain) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-lg w-full mx-4 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            How this inherited access arose
          </h3>
          <button
            onClick={onClose}
            className="text-gray-500 dark:text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-lg leading-none"
            aria-label="Close"
          >×</button>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-300 mb-3">
          <strong>{pathExplain.memberName}</strong> reaches <strong>{pathExplain.resourceName}</strong> through a
          grant higher in the scope hierarchy:
        </p>
        {pathExplain.loading && <p className="text-sm text-gray-500">Computing path…</p>}
        {pathExplain.error && <p className="text-sm text-red-600">{pathExplain.error}</p>}
        {pathExplain.sources?.length > 0 && (
          <div className="mb-3 text-sm rounded bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-3 py-2">
            <span className="font-medium text-amber-800 dark:text-amber-300">Granted: </span>
            {pathExplain.sources.map((s, i) => (
              <span key={i}>{i > 0 ? ', ' : ''}{s.role} on {s.label}:<strong> {s.name}</strong></span>
            ))}
          </div>
        )}
        {pathExplain.chain?.length > 0 && (
          <ol className="space-y-1">
            {pathExplain.chain.map((c, i) => (
              <li key={c.id} className="flex items-center gap-2 text-sm" style={{ paddingLeft: `${i * 18}px` }}>
                <span className="text-gray-500 dark:text-gray-500">{i === 0 ? '•' : '└'}</span>
                <span className="px-1.5 py-0.5 rounded text-[11px] font-medium bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">{c.label}</span>
                <span className={c.isSource ? 'font-semibold text-gray-900 dark:text-gray-100' : 'text-gray-700 dark:text-gray-300'}>{c.name}</span>
                {c.isSource && <span className="text-[10px] text-amber-600 dark:text-amber-400">← granted here</span>}
              </li>
            ))}
          </ol>
        )}
        {!pathExplain.loading && !pathExplain.error && !(pathExplain.sources?.length) && (
          <p className="text-sm text-gray-500">No scope-inheritance path found — this may be a directly-declared indirect grant.</p>
        )}
      </div>
    </div>
  );
}
