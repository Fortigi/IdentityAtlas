import { useMemo, useState } from 'react';
import { variantMeta, targetTypeMeta } from '../../utils/contextStyles';
import { flattenTree } from '../../hooks/useContextTrees';

// Flat list rendering of the same subtree — useful for large trees (AD OUs
// with thousands of nodes) where the tree view is too dense. Columns are
// sortable on the client; the server returns ≤ a full subtree so sort state
// doesn't need to round-trip.

const SORT_FIELDS = [
  { key: 'displayName',       label: 'Name' },
  { key: 'variant',           label: 'Variant' },
  { key: 'targetType',        label: 'Target' },
  { key: 'contextType',       label: 'Context type' },
  { key: 'directMemberCount', label: 'Direct' },
  { key: 'totalMemberCount',  label: 'Total' },
];

export default function ContextListView({ nodes, onOpenDetail }) {
  const flat = useMemo(() => flattenTree(nodes), [nodes]);
  const [sort, setSort] = useState({ key: 'displayName', dir: 'asc' });
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    if (!search) return flat;
    const q = search.toLowerCase();
    return flat.filter(n => (n.displayName || '').toLowerCase().includes(q));
  }, [flat, search]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    copy.sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'number') return sort.dir === 'asc' ? av - bv : bv - av;
      return sort.dir === 'asc' ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
    });
    return copy;
  }, [filtered, sort]);

  function toggleSort(key) {
    setSort(prev => prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' });
  }

  return (
    <div className="p-3">
      <div className="mb-2 flex items-center gap-2">
        <input
          placeholder="Filter by name…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="px-2 py-1 border rounded text-xs w-64"
        />
        <span className="text-xs text-gray-500">{sorted.length} / {flat.length} nodes</span>
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left border-b border-gray-200 bg-gray-50">
            {SORT_FIELDS.map(f => (
              <th key={f.key} className="px-2 py-1 font-medium text-gray-600 cursor-pointer select-none" onClick={() => toggleSort(f.key)}>
                {f.label}{sort.key === f.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map(n => {
            const v = variantMeta(n.variant);
            const t = targetTypeMeta(n.targetType);
            return (
              <tr key={n.id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-2 py-1">
                  <span className="inline-block" style={{ paddingLeft: `${n._depth * 12}px` }} />
                  <button onClick={() => onOpenDetail(n.id, n.displayName)} className="text-gray-900 hover:underline text-left">
                    {n.displayName}
                  </button>
                </td>
                <td className="px-2 py-1">
                  <span className={`inline-flex items-center gap-1 text-[10px] ${v.textClass}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${v.dotClass}`} />{v.label}
                  </span>
                </td>
                <td className="px-2 py-1">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded border ${t.badgeClass}`}>{t.label}</span>
                </td>
                <td className="px-2 py-1 text-gray-700">{n.contextType}</td>
                <td className="px-2 py-1 text-gray-700">{n.directMemberCount ?? 0}</td>
                <td className="px-2 py-1 text-gray-700">{n.totalMemberCount ?? 0}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
