import { useState } from 'react';
import { variantMeta } from '@ui/utils/contextStyles';
import { splitContexts } from '@ui/utils/matrixContexts';

// Right-side "Contexts" metadata cell of a matrix row (#870): the
// Resource-targeted contexts this row's resource is a member of, as chips
// (server-ordered by contextType, then name). Shows the first two; the +N
// button toggles the rest inline. Display-only — filtering by context stays in
// ContextFilterControl. Chip visuals mirror its variant-dot chips.
export default function MatrixContextsCell({ contexts = [] }) {
  const [expanded, setExpanded] = useState(false);
  const { shown, hiddenCount } = splitContexts(contexts, expanded);

  return (
    <td className="border-b border-gray-200 dark:border-gray-700 px-2 py-0.5 text-xs text-gray-700 dark:text-gray-300"
        style={{ minWidth: '220px' }}>
      {shown.length === 0 ? (
        <span className="text-gray-600 dark:text-gray-500">—</span>
      ) : (
        <div className="flex items-center gap-1 flex-wrap">
          {shown.map(c => {
            const variant = variantMeta(c.variant);
            return (
              <span
                key={c.id}
                className="inline-flex items-center gap-1 text-[11px] bg-slate-50 dark:bg-gray-700/50 border border-slate-200 dark:border-gray-600 rounded px-1.5 py-0.5"
                title={`${c.displayName} (${c.contextType})`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${variant.dotClass}`} aria-hidden="true" />
                <span className="max-w-[10rem] truncate">{c.displayName}</span>
              </span>
            );
          })}
          {(hiddenCount > 0 || expanded) && (
            <button
              type="button"
              onClick={() => setExpanded(e => !e)}
              aria-label={expanded ? 'Show fewer contexts' : `Show ${hiddenCount} more contexts`}
              className="text-[11px] font-medium text-blue-700 dark:text-blue-400 hover:underline"
            >
              {expanded ? 'less' : `+${hiddenCount}`}
            </button>
          )}
        </div>
      )}
    </td>
  );
}
