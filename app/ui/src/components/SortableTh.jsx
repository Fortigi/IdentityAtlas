import { FOCUS_RING } from '@ui/utils/keyActivate';

// A sortable table column header.
//
// A <th> can't itself be a button (it has to stay a columnheader), so the <th>
// carries `aria-sort` and wraps a real <button> — that is what makes the column
// reachable by Tab and operable by Enter/Space. Every sortable table in the app
// uses this rather than hanging an onClick on the <th>.

const ARIA_SORT = { asc: 'ascending', desc: 'descending' };

export default function SortableTh({
  label,
  active,
  dir,
  onSort,
  align = 'left',
  // Layout/typography of the header cell — each table keeps its own look.
  className = 'px-3 py-2 font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700',
  // Glyph shown on the columns that are not the active sort. Pass null for
  // tables that show nothing until a column is sorted.
  inactiveIndicator = '▴',
}) {
  return (
    <th
      scope="col"
      aria-sort={active ? ARIA_SORT[dir] : 'none'}
      className={`select-none ${align === 'right' ? 'text-right' : 'text-left'} ${className}`}
    >
      <button
        type="button"
        onClick={onSort}
        className={`inline-flex w-full items-center gap-1 rounded cursor-pointer ${align === 'right' ? 'justify-end' : ''} ${FOCUS_RING}`}
      >
        {label}
        {/* Direction glyph is decorative — `aria-sort` on the <th> is what a
            screen reader announces. */}
        {active ? (
          <span aria-hidden="true" className="text-blue-600 text-[10px]">{dir === 'asc' ? '▲' : '▼'}</span>
        ) : (
          <span aria-hidden="true" className="text-gray-500 dark:text-gray-500 text-[10px] inline-block w-2">{inactiveIndicator}</span>
        )}
      </button>
    </th>
  );
}
