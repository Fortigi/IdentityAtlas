import { useState } from 'react';
import { variantMeta } from '@ui/utils/contextStyles';
import { splitContextChips } from '@ui/utils/resourceContexts';

// The Contexts a resource belongs to, as a right-side metadata column of the
// matrix grid. Display-only: filtering by context stays in the matrix filter
// wizard's context control, so this column has no sort or filter of its own.
//
// A resource can sit in many contexts (group category, tags, clusters, …), so
// only the first two chips show; "+N" reveals the rest inline.
export default function MatrixContextsCell({ contexts }) {
  const [expanded, setExpanded] = useState(false);
  const { shown, hiddenCount } = splitContextChips(contexts, expanded);

  return (
    <td className="border-b border-r border-gray-200 dark:border-gray-700 px-2 py-0.5 text-xs max-w-[260px]">
      {shown.length === 0 ? (
        <span className="text-gray-500 dark:text-gray-500">&mdash;</span>
      ) : (
        <div className="flex flex-wrap items-center gap-1">
          {shown.map(c => (
            <span
              key={c.id}
              title={`${c.displayName} (${c.contextType})`}
              className={`inline-flex items-center gap-1 rounded border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700/50 px-1 text-[10px] leading-4 max-w-[110px] ${variantMeta(c.variant).textClass}`}
            >
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${variantMeta(c.variant).dotClass}`} />
              <span className="truncate">{c.displayName}</span>
            </span>
          ))}
          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              aria-label={`Show ${hiddenCount} more contexts`}
              className="rounded border border-gray-300 dark:border-gray-600 px-1 text-[10px] leading-4 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-600"
            >
              +{hiddenCount}
            </button>
          )}
        </div>
      )}
    </td>
  );
}
