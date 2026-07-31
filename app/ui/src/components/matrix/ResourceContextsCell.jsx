import { useState } from 'react';
import { variantMeta } from '@ui/utils/contextStyles';
import { visibleContexts } from './resourceContextCell';

// Right-side "Contexts" metadata cell of a matrix resource row (#870): the
// Contexts this resource is a member of (group category, tags, clusters, …).
// Shows the first 2 chips (server-sorted by contextType, displayName); a "+N"
// button expands the rest inline in the cell. Display-only — filtering by
// context stays in the wizard's ContextFilterControl.
export default function ResourceContextsCell({ contexts }) {
  const [expanded, setExpanded] = useState(false);
  const { shown, hiddenCount } = visibleContexts(contexts, expanded);

  return (
    <td className="border-b border-gray-200 dark:border-gray-700 px-2 py-0.5 text-xs"
        style={{ minWidth: '160px', maxWidth: '320px' }}>
      {shown.length === 0 ? (
        <span className="text-gray-600 dark:text-gray-500">&mdash;</span>
      ) : (
        <div className="flex items-center gap-1 flex-wrap">
          {shown.map(c => {
            const variant = variantMeta(c.variant);
            return (
              <span
                key={c.id}
                className="inline-flex items-center gap-1 text-[10px] bg-slate-50 dark:bg-gray-700/50 border border-slate-200 dark:border-gray-600 rounded px-1 py-0"
                title={`${c.displayName} (${c.contextType})`}
              >
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${variant.dotClass}`} aria-hidden="true" />
                <span className="max-w-[9rem] truncate text-gray-700 dark:text-gray-300">{c.displayName}</span>
              </span>
            );
          })}
          {hiddenCount > 0 && (
            <button
              onClick={() => setExpanded(true)}
              aria-label={`Show ${hiddenCount} more context${hiddenCount === 1 ? '' : 's'}`}
              className="text-[10px] font-medium text-blue-700 dark:text-blue-300 hover:text-blue-800 dark:hover:text-blue-200 px-0.5"
            >
              +{hiddenCount}
            </button>
          )}
          {expanded && (
            <button
              onClick={() => setExpanded(false)}
              aria-label="Show fewer contexts"
              className="text-[10px] font-medium text-blue-700 dark:text-blue-300 hover:text-blue-800 dark:hover:text-blue-200 px-0.5"
            >
              &minus;
            </button>
          )}
        </div>
      )}
    </td>
  );
}
