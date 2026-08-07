import { useState } from 'react';
import { targetTypeMeta } from '@ui/utils/contextStyles';
import { splitContexts } from '@ui/utils/resourceContexts';

// Cell listing the Contexts a resource row belongs to (group category, tags,
// clusters, …). Display only — filtering by context stays in the matrix filter
// wizard's context picker.
//
// Two chips show by default (server-sorted by contextType, then name); the rest
// expand inline via a "+N" toggle so a resource in many contexts doesn't stretch
// every row.
//
// The caller supplies the cell chrome (`className`/`style`) because the column
// is pinned next to the resource name, so the <td> needs the row's own sticky
// classes and left offset — the same ones the header cell above it carries.
export default function MatrixContextsCell({ contexts, className = '', style }) {
  const [expanded, setExpanded] = useState(false);
  const all = Array.isArray(contexts) ? contexts : [];
  const { shown, hiddenCount } = splitContexts(all);
  const visible = expanded ? all : shown;
  const chipClass = targetTypeMeta('Resource').badgeClass;

  return (
    <td className={`border-b border-gray-200 dark:border-gray-700 px-2 py-0.5 text-xs ${className}`} style={style}>
      {visible.length === 0 ? (
        <span className="text-gray-600 dark:text-gray-500">&mdash;</span>
      ) : (
        <div className="flex flex-wrap items-center gap-1">
          {visible.map(ctx => (
            <span
              key={ctx.id}
              className={`inline-block max-w-[110px] truncate rounded border px-1 leading-4 text-[10px] ${chipClass}`}
              title={`${ctx.contextType || 'Context'}: ${ctx.displayName}`}
            >
              {ctx.displayName}
            </span>
          ))}
          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setExpanded(e => !e)}
              aria-label={expanded ? `Show fewer contexts` : `Show ${hiddenCount} more contexts`}
              className="rounded border border-gray-300 dark:border-gray-600 px-1 leading-4 text-[10px] text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              {expanded ? '−' : `+${hiddenCount}`}
            </button>
          )}
        </div>
      )}
    </td>
  );
}
