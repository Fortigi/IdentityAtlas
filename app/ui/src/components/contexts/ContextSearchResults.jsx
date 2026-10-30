import { useContextSearch } from '@ui/hooks/useContextTrees';
import { formatMatchedOn } from '@ui/utils/matchedOn';
import { categoryMeta, memberKindLabel } from '@ui/utils/contextStyles';
import { CONTEXT_EXTENDED_SEARCH_LABEL } from './treePanel.helpers';

// The Contexts pane while a search is typed: matches from every level of every
// tree (not only the roots the pane normally lists), each selecting its unit.
// A hit can come from any tab, so it says where it lives in words — template,
// kind of member, type — in neutral text, no colour per classification. With
// the extended search on, each says which field matched (the CMDB reference a
// logical application was found by, say).
export default function ContextSearchResults({ term, extended, onOpenContext }) {
  const { results, loading, error } = useContextSearch(term, extended);

  if (loading) return <div className="p-3 text-xs text-gray-500 dark:text-gray-400">Searching…</div>;
  if (error) return <div className="p-3 text-xs text-red-700 dark:text-red-400" role="alert">{error}</div>;
  if (results.length === 0) {
    return (
      <div className="p-3 text-xs text-gray-500 dark:text-gray-400">
        Nothing matches “{term.trim()}”.{!extended && ` Tick “${CONTEXT_EXTENDED_SEARCH_LABEL}” to also search CMDB references and other fields.`}
      </div>
    );
  }
  return (
    <ul aria-label="Search results">
      {results.map(c => {
        const matched = formatMatchedOn(c.matchedOn);
        const where = [categoryMeta(c.contextCategory).label, memberKindLabel(c.targetType), c.contextType].filter(Boolean).join(' · ');
        return (
          <li key={c.id}>
            <button
              onClick={() => onOpenContext?.(c.id, c.displayName)}
              className="w-full text-left px-3 py-2 text-xs border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50"
            >
              <div className="font-medium text-gray-900 dark:text-white truncate">{c.displayName}</div>
              <div className="mt-0.5 text-gray-600 dark:text-gray-400 truncate">{where}</div>
              {matched && (
                <div className="mt-0.5 text-gray-600 dark:text-gray-400 truncate">Matched on {matched}</div>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
