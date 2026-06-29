import { useMemo, useState } from 'react';
import { formatDate, formatDateOnly, friendlyLabel } from '@ui/utils/formatters';
import { OP_STYLES, KIND_TO_TAB, renderSummaryWithLink } from './RecentChangesSection.helpers.jsx';

// ─── EntityTimeline ────────────────────────────────────────────────────
// Horizontal timeline for the user-detail Timeline tab. Each "moment" (a
// distinct point in time from the _history audit) is a dot on a line,
// oldest on the left (e.g. the initial load) → newest on the right. A dot
// is coloured + labelled with what kind of change it was and how many
// (e.g. "2 attr · 1 rel"); clicking it expands the full detail below the
// line — attribute updates shown as before → after, relationship changes
// linked to their counterparty. Reuses RecentChangesSection's badges +
// link rendering so the two surfaces stay consistent.

const RANGES = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' },
  { days: 1095, label: 'All' },
];

const REL_KINDS = new Set(['assignment', 'relationship', 'identity-member', 'manager', 'review']);

function summarize(moment) {
  let attr = 0, rel = 0, created = false;
  for (const ev of moment.events) {
    if (ev.summary === 'Account created') created = true;
    if (ev.eventKind === 'attribute') attr += 1;
    else if (REL_KINDS.has(ev.eventKind)) rel += 1;
    else attr += 1;
  }
  return { attr, rel, created };
}

// Dot border colour by kind: created = emerald (the start), relationship-
// involving = amber (access changed — the notable ones), attribute-only = blue.
// The dot itself is white with a dark number inside (the change count), so the
// number stays WCAG-readable regardless of the kind colour.
function dotBorder(moment) {
  const { rel, created } = summarize(moment);
  if (created) return 'border-emerald-500 dark:border-emerald-400';
  if (rel > 0) return 'border-amber-500 dark:border-amber-400';
  return 'border-blue-500 dark:border-blue-400';
}

function contextLabel(moment) {
  const { attr, rel, created } = summarize(moment);
  if (created) return 'Created';
  return [attr && `${attr} attr`, rel && `${rel} rel`].filter(Boolean).join(' · ');
}

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

export default function EntityTimeline({ events, loading, sinceDays, onSinceDaysChange, onOpenDetail }) {
  // Group events into one dot per DAY, oldest → newest (left → right). A day's
  // dot bundles everything that changed that day; clicking it lists them all.
  const moments = useMemo(() => {
    const byDay = new Map();
    for (const ev of events || []) {
      const d = new Date(ev.at);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (!byDay.has(key)) byDay.set(key, { at: ev.at, events: [] });
      const m = byDay.get(key);
      m.events.push(ev);
      if (new Date(ev.at) > new Date(m.at)) m.at = ev.at; // representative = latest that day
    }
    const arr = [...byDay.values()];
    for (const m of arr) m.events.sort((a, b) => new Date(a.at) - new Date(b.at));
    arr.sort((a, b) => new Date(a.at) - new Date(b.at));
    return arr;
  }, [events]);

  // Default selection = the most recent moment (no effect needed, so it also
  // renders correctly server-side). Clicking a dot overrides it.
  const [sel, setSel] = useState(null);
  const selIdx = (sel != null && sel >= 0 && sel < moments.length) ? sel : moments.length - 1;

  const RangeSelector = (
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
  );

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg">
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Timeline</h3>
        {RangeSelector}
      </div>

      {loading ? (
        <div className="p-6 text-center text-sm text-gray-500 dark:text-gray-400">Loading timeline…</div>
      ) : moments.length === 0 ? (
        <p className="p-6 text-sm text-gray-600 dark:text-gray-500 italic">No changes recorded in this period.</p>
      ) : (
        <>
          {/* Horizontal axis of dots */}
          <div className="overflow-x-auto pb-1">
            <div className="relative flex gap-8 px-6 pt-3 min-w-max">
              <div className="absolute left-6 right-6 top-[24px] h-0.5 bg-gray-200 dark:bg-gray-700" aria-hidden="true" />
              {moments.map((m, i) => {
                const isSel = i === selIdx;
                return (
                  <button
                    key={m.at}
                    type="button"
                    onClick={() => setSel(i)}
                    aria-pressed={isSel}
                    title={`${formatDateOnly(m.at)} — ${contextLabel(m)}`}
                    className="group relative z-10 flex w-20 shrink-0 flex-col items-center focus:outline-none"
                  >
                    <span
                      className={`flex items-center justify-center w-6 h-6 rounded-full bg-white dark:bg-gray-800 border-2 text-[10px] font-bold tabular-nums text-gray-800 dark:text-gray-100 transition-transform ${dotBorder(m)} ${isSel ? 'scale-110 ring-2 ring-blue-300 dark:ring-blue-700' : 'group-hover:scale-105'}`}
                      title={`${m.events.length} change${m.events.length === 1 ? '' : 's'}`}
                    >
                      {m.events.length}
                    </span>
                    <span className="mt-2 text-[10px] leading-tight text-center text-gray-500 dark:text-gray-400">{formatDateOnly(m.at)}</span>
                    <span className={`text-[10px] leading-tight text-center ${isSel ? 'text-gray-700 dark:text-gray-200 font-medium' : 'text-gray-500 dark:text-gray-500'}`}>
                      {contextLabel(m)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Detail of the selected day */}
          <div className="border-t border-gray-200 dark:border-gray-700 px-4 py-3">
            <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">
              {formatDateOnly(moments[selIdx].at)}
              <span className="ml-2 font-normal text-gray-500 dark:text-gray-400">{contextLabel(moments[selIdx])}</span>
            </h4>
            <ul className="space-y-2">
              {moments[selIdx].events.map((ev, i) => {
                const style = OP_STYLES[ev.operation] || OP_STYLES.changed;
                const target = KIND_TO_TAB[ev.counterpartyKind];
                const linkable = ev.counterpartyLabel && target && ev.counterpartyId;
                return (
                  <li key={i} className="flex items-start gap-2">
                    <span className="mt-0.5 text-xs text-gray-500 dark:text-gray-400 tabular-nums shrink-0 w-12" title={formatDate(ev.at)}>
                      {new Date(ev.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <span className={`mt-0.5 inline-block px-2 py-0.5 rounded-full text-xs font-medium border shrink-0 ${style.badge}`}>
                      {style.label}
                    </span>
                    <div className="text-sm text-gray-900 dark:text-gray-100">
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
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
