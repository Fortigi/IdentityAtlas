// Shared operation badges + counterparty-link rendering for the Recent Changes
// timeline. Extracted from RecentChangesSection.jsx so that file only exports a
// component (Vite fast-refresh requirement) while the user Timeline tab
// (EntityTimeline.jsx / UserTimeline.jsx) still shares one source of truth.

// Exported so the timeline tabs share the exact same operation badges.
export const OP_STYLES = {
  added:   { badge: 'bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200 border-amber-200 dark:border-amber-700',       label: 'Added' },
  removed: { badge: 'bg-rose-100 dark:bg-rose-900/30 text-rose-800 dark:text-rose-200 border-rose-200 dark:border-rose-700',              label: 'Removed' },
  changed: { badge: 'bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-200 border-blue-200 dark:border-blue-700',              label: 'Changed' },
};

export const KIND_TO_TAB = {
  user:             'user',
  resource:         'resource',
  'access-package': 'access-package',
  identity:         'identity',
  context:          'context',
};

// Split the summary around the counterparty label so the label renders
// as a link. The summary format is consistent (backend controls it), so
// a simple first-occurrence split is reliable and keeps the rest of the
// phrasing intact.
export function renderSummaryWithLink(ev, target, onOpenDetail) {
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
