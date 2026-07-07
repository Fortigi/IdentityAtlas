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

import { useMemo, useState } from 'react';
import { friendlyLabel } from '@ui/utils/formatters';

const ENTITY_LABELS = {
  user:             'User',
  resource:         'Resource',
  'access-package': 'Business Role',
  identity:         'Identity',
  context:          'Context',
  leaf:             '',
};

const DETAIL_TARGET = {
  user:             'user',
  resource:         'resource',
  'access-package': 'access-package',
  identity:         'identity',
  context:          'context',
};

// The type label for a row: the assignment's resourceType (Group / Group
// Ownership / App Role / …) when present, else the counterparty entity kind
// (e.g. "User" on a resource's member list). Exported + pure so it's testable.
export function rowType(it) {
  return it.resourceType ? friendlyLabel(it.resourceType) : (ENTITY_LABELS[it.entityKind] || '');
}

// Sort a copy of the items by 'name' (label) or 'type' (rowType), asc/desc,
// case-insensitive, with the other column as a stable tiebreak. Pure.
export function sortItems(items, key, dir) {
  const mult = dir === 'desc' ? -1 : 1;
  const val = (it) => (key === 'type' ? rowType(it) : (it.label || '')).toLowerCase();
  const tie = (it) => (it.label || '').toLowerCase();
  return [...(items || [])].sort((a, b) => {
    const av = val(a), bv = val(b);
    if (av !== bv) return av < bv ? -mult : mult;
    const at = tie(a), bt = tie(b);
    return at < bt ? -1 : at > bt ? 1 : 0;
  });
}

// Build a CSV (Name, Type, Via) from the items. RFC-4180 quoting. Pure.
export function itemsToCsv(items) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = ['Name,Type,Via'];
  for (const it of items || []) {
    lines.push([it.label || '', rowType(it), it.via || ''].map(esc).join(','));
  }
  return lines.join('\r\n');
}

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
      <span className="ml-1 inline-block w-2 text-gray-400 dark:text-gray-500">{active ? (dir === 'asc' ? '▲' : '▼') : ''}</span>
    </th>
  );
}

export default function ExpandedItemsList({ label, items, loading, onOpenDetail }) {
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' });
  const sorted = useMemo(() => sortItems(items, sort.key === 'type' ? 'type' : 'name', sort.dir), [items, sort]);

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
    downloadCsv(`${slug}.csv`, itemsToCsv(sorted));
  };

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50 dark:bg-gray-900/40 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">{label || 'Selected'}</h3>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-500 dark:text-gray-400">{items.length}</span>
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
      <div className="max-h-[460px] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-gray-50 dark:bg-gray-900/40 border-b border-gray-200 dark:border-gray-700">
            <tr>
              <SortHeader label="Name" active={sort.key === 'name'} dir={sort.dir} onClick={() => toggleSort('name')} />
              <SortHeader label="Type" active={sort.key === 'type'} dir={sort.dir} onClick={() => toggleSort('type')} align="right" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((it, i) => {
              const target = DETAIL_TARGET[it.entityKind];
              const typeLabel = rowType(it);
              const clickable = target && !it.overflow && it.entityId;
              return (
                <tr key={it.key + ':' + i} className="border-b border-gray-50 dark:border-gray-700/50 last:border-b-0 hover:bg-gray-50 dark:hover:bg-gray-700/40">
                  <td className="px-4 py-2 align-top">
                    {clickable ? (
                      <button
                        onClick={() => onOpenDetail?.(target, it.entityId, it.label)}
                        className="text-blue-700 dark:text-blue-300 hover:text-blue-900 dark:hover:text-blue-100 hover:underline text-left font-medium"
                      >
                        {it.label}
                      </button>
                    ) : (
                      <span className="text-gray-900 dark:text-gray-100">{it.label}</span>
                    )}
                    {it.via && (
                      <div className="text-xs text-gray-600 dark:text-gray-400 mt-0.5">
                        via {it.via}
                        {it.viaType ? ` · ${it.viaType}` : ''}
                        {it.viaPrimary ? ' · primary' : ''}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap align-top">
                    {typeLabel}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
