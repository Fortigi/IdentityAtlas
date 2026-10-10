// Context builder — the table, badges and row buttons the match blocks share (resources,
// organisation entities, users), so the three look and behave alike.

import { MUTED } from '@ui/components/reports/ask/AskAssistant.styles';

export const MAX_ROWS = 300;
export const NAME_BUTTON = 'text-left text-sm font-medium text-blue-700 hover:underline dark:text-blue-300';
export const ROW_BUTTON = 'text-xs font-medium text-gray-700 hover:text-blue-700 dark:text-gray-300';
export const CELL = 'px-3 py-1.5';
export const CHIP = 'mr-1 inline-block rounded px-1.5 py-0.5 text-[11px]';
export const SUBHEAD = 'text-sm font-semibold text-gray-800 dark:text-gray-200';

const STATUS_BADGE = {
  included: { text: 'added by hand', cls: 'bg-blue-50 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300' },
  excluded: { text: 'excluded', cls: 'bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-300' },
};

/** "added by hand" / "excluded" next to a name; nothing for an ordinary match. */
export function StatusBadge({ status }) {
  const badge = STATUS_BADGE[status];
  return badge ? <span className={`ml-2 rounded px-1.5 py-0.5 text-[11px] ${badge.cls}`}>{badge.text}</span> : null;
}

/**
 * @param {object}   props
 * @param {string[]} props.headers  column headings; an empty string is an unlabelled column
 * @param {Array}    props.rows     every row; only the first MAX_ROWS are drawn
 * @param {Function} props.renderRow (row) → <tr>
 * @param {string}   [props.label]   accessible name of the table
 */
export function MatchTable({ headers, rows, renderRow, label }) {
  if (rows.length === 0) return <p className={MUTED}>Nothing here.</p>;
  return (
    <div className="overflow-x-auto rounded border border-gray-200 dark:border-gray-700">
      <table className="min-w-full divide-y divide-gray-100 text-sm dark:divide-gray-700" aria-label={label}>
        <thead className="bg-gray-50 text-left text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-400">
          <tr>{headers.map((t, i) => <th key={i} className={CELL}>{t}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
          {rows.slice(0, MAX_ROWS).map(renderRow)}
        </tbody>
      </table>
      {rows.length > MAX_ROWS && <p className={`px-3 py-2 ${MUTED}`}>Showing the first {MAX_ROWS} of {rows.length}.</p>}
    </div>
  );
}
