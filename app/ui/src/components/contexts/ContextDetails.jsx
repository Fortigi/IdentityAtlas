import { useState } from 'react';
import { formatValue } from '@ui/utils/formatters';
import { detailEntries, detailLabel } from './ContextDetails.helpers';

// ─── "More details": every attribute the rest of the page does not show ──
// Replaces the old Attributes tab. Which keys are left out (because the
// header, the description card or the profile already shows them, or because
// the reader is not the analyst) is ContextDetails.helpers.js. A short list
// is open; a long one (more than OPEN_UP_TO rows) starts folded.
//
// `framed`: its own card (a context without a profile) — inside a profile's
// facts card it sits under a divider instead. `analyst`: the reader can edit
// contexts and also sees the raw classification.

const OPEN_UP_TO = 6;

export default function ContextDetails({ attrs, hasProfile = false, framed = false, analyst = false }) {
  const entries = detailEntries(attrs, { hasProfile, analyst });
  const [open, setOpen] = useState(entries.length <= OPEN_UP_TO);
  if (entries.length === 0) return null;

  const frame = framed
    ? 'bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-6 py-3'
    : 'mt-3 pt-3 border-t border-gray-100 dark:border-gray-700';
  return (
    <section aria-label="More details" className={frame}>
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="flex items-center gap-1 text-xs font-semibold text-gray-700 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white">
        <span aria-hidden="true">{open ? '▼' : '▶'}</span>
        More details
        <span className="font-normal text-gray-600 dark:text-gray-400">({entries.length})</span>
      </button>
      {open && (
        <dl className="mt-2 grid grid-cols-[auto_1fr] sm:grid-cols-[auto_1fr_auto_1fr] gap-x-3 gap-y-1 text-xs">
          {entries.map(([key, value, meta]) => (
            <DetailRow key={meta?.extended ? `ext:${key}` : key} label={meta?.extended ? key : detailLabel(key)} value={value} />
          ))}
        </dl>
      )}
    </section>
  );
}

function DetailRow({ label, value }) {
  return (
    <>
      <dt className="text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="text-gray-900 dark:text-gray-200 break-all whitespace-pre-wrap">{formatValue(value)}</dd>
    </>
  );
}
