import { useState } from 'react';
import { formatDate } from '../utils/formatters';

// ─── RecentChangesSection ────────────────────────────────────────────
// Collapsible timeline of relationship-level changes for the entity
// being viewed: assignments in/out, manager changes, containment shifts,
// identity-member links. Sits alongside the attribute-level Version
// History but reads the relationship tables so permission-debugging
// gets a single "what moved recently" surface.

const OP_STYLES = {
  added:   { badge: 'bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200 border-amber-200 dark:border-amber-700',       label: 'Added' },
  removed: { badge: 'bg-rose-100 dark:bg-rose-900/30 text-rose-800 dark:text-rose-200 border-rose-200 dark:border-rose-700',              label: 'Removed' },
  changed: { badge: 'bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-200 border-blue-200 dark:border-blue-700',              label: 'Changed' },
};

const KIND_TO_TAB = {
  user:             'user',
  resource:         'resource',
  'access-package': 'access-package',
  identity:         'identity',
  context:          'context',
};

export default function RecentChangesSection({
  events,
  addedCount,
  removedCount,
  sinceDays,
  loading,
  onOpenDetail,
}) {
  const [open, setOpen] = useState(false);
  const total = events?.length || 0;
  const hasData = total > 0;

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-50 dark:bg-gray-900/40 border-b border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700/50"
      >
        <div className="flex items-center gap-2">
          <span className="text-gray-400 dark:text-gray-500 text-xs">{open ? '▼' : '▶'}</span>
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Recent Changes</h3>
          {sinceDays && <span className="text-xs text-gray-400 dark:text-gray-500">last {sinceDays} days</span>}
        </div>
        <div className="flex items-center gap-2 text-xs">
          {addedCount > 0 && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full font-medium bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-700">
              +{addedCount}
            </span>
          )}
          {removedCount > 0 && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full font-medium bg-rose-50 dark:bg-rose-900/30 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-700">
              −{removedCount}
            </span>
          )}
          {!hasData && !loading && (
            <span className="text-gray-400 dark:text-gray-500">No changes</span>
          )}
        </div>
      </button>

      {open && (
        <div className="max-h-[360px] overflow-y-auto">
          {loading ? (
            <div className="p-4 text-center text-sm text-gray-500 dark:text-gray-400">Loading…</div>
          ) : !hasData ? (
            <p className="p-4 text-sm text-gray-400 dark:text-gray-500 italic">
              No relationship changes recorded in the last {sinceDays || 30} days.
            </p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {events.map((ev, i) => {
                  const style = OP_STYLES[ev.operation] || OP_STYLES.changed;
                  const target = KIND_TO_TAB[ev.counterpartyKind];
                  return (
                    <tr key={i} className="border-b border-gray-50 dark:border-gray-700/50 last:border-b-0">
                      <td className="px-4 py-2 align-top whitespace-nowrap text-xs text-gray-500 dark:text-gray-400 w-44">
                        {formatDate(ev.at)}
                      </td>
                      <td className="px-2 py-2 align-top whitespace-nowrap">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium border ${style.badge}`}>
                          {style.label}
                        </span>
                      </td>
                      <td className="px-4 py-2 align-top text-gray-900 dark:text-gray-100">
                        {ev.counterpartyLabel && target && ev.counterpartyId ? (
                          <>
                            {renderSummaryWithLink(ev, target, onOpenDetail)}
                          </>
                        ) : (
                          <span>{ev.summary}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

// Split the summary around the counterparty label so the label renders
// as a link. The summary format is consistent (backend controls it), so
// a simple first-occurrence split is reliable and keeps the rest of the
// phrasing intact.
function renderSummaryWithLink(ev, target, onOpenDetail) {
  const label = ev.counterpartyLabel;
  const summary = ev.summary;
  const idx = summary.indexOf(label);
  if (idx < 0) {
    return (
      <>
        <span>{summary} — </span>
        <button onClick={() => onOpenDetail?.(target, ev.counterpartyId, label)}
                className="text-blue-700 dark:text-blue-300 hover:underline font-medium">
          {label}
        </button>
      </>
    );
  }
  return (
    <>
      <span>{summary.slice(0, idx)}</span>
      <button onClick={() => onOpenDetail?.(target, ev.counterpartyId, label)}
              className="text-blue-700 dark:text-blue-300 hover:underline font-medium">
        {label}
      </button>
      <span>{summary.slice(idx + label.length)}</span>
    </>
  );
}
