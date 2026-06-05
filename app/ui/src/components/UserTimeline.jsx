import { formatDate, friendlyLabel } from '../utils/formatters';
import { OP_STYLES, KIND_TO_TAB, renderSummaryWithLink } from './RecentChangesSection';

// ─── UserTimeline ────────────────────────────────────────────────────
// Vertical timeline for the user-detail Timeline tab: one dot per change,
// newest first, merging attribute updates and relationship changes
// (assignments, identity links, manager) from /api/user/:id/timeline.
// Attribute events show the field-level from → to diff; relationship events
// link to the counterparty's detail page. Reuses RecentChangesSection's
// operation badges + link rendering so the two surfaces stay consistent.

const RANGES = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' },
  { days: 1095, label: 'All' },
];

// Dot colour keyed on the operation, matching the OP_STYLES badge hues.
const DOT = {
  added: 'bg-amber-400 dark:bg-amber-500',
  removed: 'bg-rose-400 dark:bg-rose-500',
  changed: 'bg-blue-400 dark:bg-blue-500',
};

function AttributeDiff({ attribute }) {
  return (
    <span className="text-xs">
      <span className="font-medium text-gray-700 dark:text-gray-300">{friendlyLabel(attribute.field)}</span>
      <span className="text-gray-600 dark:text-gray-500 mx-1">:</span>
      <span className="text-red-600 dark:text-red-400 line-through mr-1">{attribute.from}</span>
      <span className="text-gray-600 dark:text-gray-500 mr-1">&rarr;</span>
      <span className="text-green-700 dark:text-green-400">{attribute.to}</span>
    </span>
  );
}

export default function UserTimeline({ events, loading, sinceDays, onSinceDaysChange, onOpenDetail }) {
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg">
      {/* Range selector */}
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Timeline</h3>
        <div className="flex gap-1" role="group" aria-label="Time range">
          {RANGES.map(r => {
            const active = r.days === sinceDays;
            return (
              <button
                key={r.days}
                type="button"
                onClick={() => onSinceDaysChange?.(r.days)}
                aria-pressed={active}
                className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                  active
                    ? 'bg-blue-600 text-white dark:bg-blue-700'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
                }`}
              >
                {r.label}
              </button>
            );
          })}
        </div>
      </div>

      {loading ? (
        <div className="p-6 text-center text-sm text-gray-500 dark:text-gray-400">Loading timeline…</div>
      ) : !events || events.length === 0 ? (
        <p className="p-6 text-sm text-gray-600 dark:text-gray-500 italic">
          No changes recorded in this period.
        </p>
      ) : (
        <ol className="relative ml-5 my-3 border-l border-gray-200 dark:border-gray-700">
          {events.map((ev, i) => {
            const style = OP_STYLES[ev.operation] || OP_STYLES.changed;
            const dot = DOT[ev.operation] || DOT.changed;
            const target = KIND_TO_TAB[ev.counterpartyKind];
            const linkable = ev.counterpartyLabel && target && ev.counterpartyId;
            return (
              <li key={i} className="relative pl-5 pr-4 py-2">
                <span className={`absolute -left-[5px] top-3.5 w-2.5 h-2.5 rounded-full ring-2 ring-white dark:ring-gray-800 ${dot}`} aria-hidden="true" />
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">{formatDate(ev.at)}</span>
                  <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium border ${style.badge}`}>
                    {style.label}
                  </span>
                </div>
                <div className="mt-0.5 text-sm text-gray-900 dark:text-gray-100">
                  {ev.eventKind === 'attribute' && ev.attribute ? (
                    <AttributeDiff attribute={ev.attribute} />
                  ) : linkable ? (
                    renderSummaryWithLink(ev, target, onOpenDetail)
                  ) : (
                    <span>{ev.summary}</span>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
