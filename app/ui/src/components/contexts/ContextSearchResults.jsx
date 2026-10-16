import { useContextSearch } from '@ui/hooks/useContextTrees';
import { formatMatchedOn } from '@ui/utils/matchedOn';
import { variantMeta, targetTypeMeta } from '@ui/utils/contextStyles';

// The Contexts pane while a search is typed: matches from every level of every
// tree (not only the roots the pane normally lists), each opening its own
// detail tab. With "All attributes" on, each says which field matched — the
// CMDB reference a logical application was found by, say.
export default function ContextSearchResults({ term, extended, onOpenContext }) {
  const { results, loading, error } = useContextSearch(term, extended);

  if (loading) return <div className="p-3 text-xs text-gray-500 dark:text-gray-400">Searching…</div>;
  if (error) return <div className="p-3 text-xs text-red-700 dark:text-red-400" role="alert">{error}</div>;
  if (results.length === 0) {
    return (
      <div className="p-3 text-xs text-gray-500 dark:text-gray-400">
        No context matches “{term.trim()}”.{!extended && ' Tick “All attributes” to also search CMDB references and other attributes.'}
      </div>
    );
  }
  return (
    <ul aria-label="Search results">
      {results.map(c => {
        const v = variantMeta(c.variant);
        const t = targetTypeMeta(c.targetType);
        const matched = formatMatchedOn(c.matchedOn);
        return (
          <li key={c.id}>
            <button
              onClick={() => onOpenContext?.(c.id, c.displayName)}
              className={`w-full text-left px-3 py-2 text-xs border-l-4 ${v.borderClass} hover:bg-gray-50 dark:hover:bg-gray-700/50`}
            >
              <div className="font-medium text-gray-900 dark:text-white truncate">{c.displayName}</div>
              <div className="flex items-center gap-1 mt-0.5 text-[10px] text-gray-600 dark:text-gray-400">
                <span className={`inline-flex items-center px-1.5 py-0.5 rounded border ${t.badgeClass}`}>{t.label}</span>
                <span className="truncate">{c.contextType}</span>
              </div>
              {matched && (
                <div className="mt-0.5 text-[10px] text-gray-600 dark:text-gray-400 truncate">Matched on {matched}</div>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
