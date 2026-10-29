// ─── ExpandedItemsList ───────────────────────────────────────────────
// Generic list shown below the entity graph when a category has been
// drilled into. Every item the shape helper returns has the same
// shape — { key, label, kind: 'item', entityKind, entityId, resourceType? } —
// so one renderer works for every category click, regardless of whether
// it's users, resources, access packages, identities, contexts, or
// non-expandable leaves like policies/reviews/requests.
//
// Rows link to the corresponding entity detail tab when the entity
// kind has one; leaves just render the label. The list is sortable by
// Name or Type and exportable to CSV — a Direct/Indirect bucket can mix
// many resourceTypes, so being able to sort/scan/export it matters.
// Pure logic (rowType / sortItems / itemsToCsv) lives in the .helpers file.

import { useMemo, useState } from 'react';
import { rowType, sortItems, itemsToCsv, splitHistorical } from './ExpandedItemsList.helpers';
import DeletedBadge from './DeletedBadge';

const DETAIL_TARGET = {
  user:             'user',
  resource:         'resource',
  'access-package': 'access-package',
  identity:         'identity',
  context:          'context',
};

function downloadCsv(filename, csv) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function SortHeader({ label, active, dir, onClick, align = 'left' }) {
  return (
    <th
      scope="col"
      className={`px-4 py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 select-none cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 text-${align}`}
      onClick={onClick}
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      {label}
      {/* Arrow inherits the header's compliant colour (no bare light-mode -400). */}
      <span className="ml-1 inline-block w-2">{active ? (dir === 'asc' ? '▲' : '▼') : ''}</span>
    </th>
  );
}

function ItemRow({ it, onOpenDetail }) {
  const target = DETAIL_TARGET[it.entityKind];
  const clickable = target && !it.overflow && it.entityId;
  // Historical rows are muted and labelled, so they never read as current access.
  const linkClass = it.deleted
    ? 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:underline text-left line-through'
    : 'text-blue-700 dark:text-blue-300 hover:text-blue-900 dark:hover:text-blue-100 hover:underline text-left font-medium';
  return (
    <tr className="border-b border-gray-50 dark:border-gray-700/50 last:border-b-0 hover:bg-gray-50 dark:hover:bg-gray-700/40">
      <td className="px-4 py-2 align-top">
        {clickable ? (
          <button onClick={() => onOpenDetail?.(target, it.entityId, it.label)} className={linkClass}>
            {it.label}
          </button>
        ) : (
          <span className={it.deleted ? 'text-gray-600 dark:text-gray-400 line-through' : 'text-gray-900 dark:text-gray-100'}>{it.label}</span>
        )}
        {it.deleted && <DeletedBadge at={it.deletedAt} label="Historical" className="ml-2" />}
        {it.via && (
          <div className="text-xs text-gray-600 dark:text-gray-400 mt-0.5">
            via {it.via}
            {it.viaType ? ` · ${it.viaType}` : ''}
            {it.viaPrimary ? ' · primary' : ''}
          </div>
        )}
      </td>
      <td className="px-4 py-2 text-right text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap align-top">
        {rowType(it)}
      </td>
    </tr>
  );
}

// The history block under the current rows: collapsed behind a toggle by
// default, so deleted-in-source rows never mix in with current access.
function HistoryRows({ items, open, onToggle, onOpenDetail }) {
  if (items.length === 0) return null;
  return (
    <>
      <tr className="bg-gray-50 dark:bg-gray-900/40 border-y border-gray-200 dark:border-gray-700">
        <td colSpan={2} className="px-4 py-2">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="text-xs font-medium text-gray-700 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100"
          >
            {open ? 'Hide' : 'Show'} {items.length} historical (no longer in the source)
          </button>
        </td>
      </tr>
      {open && items.map((it, i) => <ItemRow key={'h:' + it.key + ':' + i} it={it} onOpenDetail={onOpenDetail} />)}
    </>
  );
}

export default function ExpandedItemsList({ label, items, loading, onOpenDetail }) {
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' });
  const [showHistory, setShowHistory] = useState(false);
  const { current, historical } = useMemo(() => {
    const key = sort.key === 'type' ? 'type' : 'name';
    const split = splitHistorical(items);
    return { current: sortItems(split.current, key, sort.dir), historical: sortItems(split.historical, key, sort.dir) };
  }, [items, sort]);

  if (loading && !items) {
    return (
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6 text-center text-sm text-gray-500 dark:text-gray-400">
        Loading…
      </div>
    );
  }
  if (!items || items.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6 text-center text-sm text-gray-600 dark:text-gray-500 italic">
        Nothing to show for this relationship.
      </div>
    );
  }

  const toggleSort = (key) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  const onExport = () => {
    const slug = (label || 'list').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'list';
    // Export what is on screen: history only once it has been unfolded.
    downloadCsv(`${slug}.csv`, itemsToCsv(showHistory ? [...current, ...historical] : current));
  };

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50 dark:bg-gray-900/40 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">{label || 'Selected'}</h3>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {current.length}{historical.length > 0 ? ` · ${historical.length} historical` : ''}
          </span>
          <button
            type="button"
            onClick={onExport}
            className="px-2 py-0.5 rounded text-xs font-medium bg-gray-200 text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
            title="Export this list to CSV"
          >
            Export CSV
          </button>
        </div>
      </div>
      <div className="max-h-[460px] overflow-y-auto overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-gray-50 dark:bg-gray-900/40 border-b border-gray-200 dark:border-gray-700">
            <tr>
              <SortHeader label="Name" active={sort.key === 'name'} dir={sort.dir} onClick={() => toggleSort('name')} />
              <SortHeader label="Type" active={sort.key === 'type'} dir={sort.dir} onClick={() => toggleSort('type')} align="right" />
            </tr>
          </thead>
          <tbody>
            {current.map((it, i) => <ItemRow key={it.key + ':' + i} it={it} onOpenDetail={onOpenDetail} />)}
            {current.length === 0 && (
              <tr>
                <td colSpan={2} className="px-4 py-3 text-sm italic text-gray-600 dark:text-gray-400">No current items.</td>
              </tr>
            )}
            <HistoryRows
              items={historical}
              open={showHistory}
              onToggle={() => setShowHistory(v => !v)}
              onOpenDetail={onOpenDetail}
            />
          </tbody>
        </table>
      </div>
    </div>
  );
}
