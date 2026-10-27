import { useMemo, useState } from 'react';
import { distinctValues } from './workbench.columns';

// ─── An Excel-like filter on one column ──────────────────────────────────
// The column's distinct values with how many people have each, "(Not known)" /
// "(Blanks)" for the people without one, a search box, Select all / None, and —
// on a knowledge column — whether proposed (not yet confirmed) values count. A
// text column also takes "Contains" texts (comma-separated: "handler, lead"): a
// person matches when a ticked value OR one of the texts fits. OK applies;
// ticking everything (proposed included, no texts) clears the filter.

const splitTerms = (s) => s.split(',').map(t => t.trim()).filter(Boolean);

export default function ColumnFilterMenu({ column, people, filter, onApply, onClose }) {
  const [includeProposed, setIncludeProposed] = useState(filter?.includeProposed !== false);
  const values = useMemo(() => distinctValues(people, column, includeProposed), [people, column, includeProposed]);
  const [ticked, setTicked] = useState(() => new Set(filter?.values ?? values.map(v => v.value)));
  const [contains, setContains] = useState((filter?.contains || []).join(', '));
  const [search, setSearch] = useState('');
  const needle = search.trim().toLowerCase();
  const shown = needle ? values.filter(v => v.label.toLowerCase().includes(needle)) : values;
  const textColumn = column.type !== 'knowledge' && column.type !== 'count';

  const toggle = (v) => setTicked(prev => { const n = new Set(prev); if (n.has(v)) n.delete(v); else n.add(v); return n; });
  const setAll = (on) => setTicked(prev => { const n = new Set(prev); for (const v of shown) { if (on) n.add(v.value); else n.delete(v.value); } return n; });
  const apply = () => {
    const terms = textColumn ? splitTerms(contains) : [];
    const everything = values.every(v => ticked.has(v.value)) && includeProposed && terms.length === 0;
    onApply(everything ? null : { values: new Set(ticked), includeProposed, contains: terms });
  };

  return (
    <div role="dialog" aria-label={`Filter ${column.label}`} onClick={e => e.stopPropagation()}
      className="absolute left-0 top-full z-50 mt-1 w-64 rounded-md border border-gray-200 bg-white p-2 text-left text-xs font-normal normal-case shadow-lg dark:border-gray-600 dark:bg-gray-800">
      <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…" aria-label={`Search ${column.label} values`}
        className="mb-1 w-full rounded border border-gray-300 bg-white px-2 py-0.5 text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100" />
      <div className="mb-1 flex gap-2">
        <button type="button" onClick={() => setAll(true)} className="text-blue-700 hover:underline dark:text-blue-300">Select all</button>
        <button type="button" onClick={() => setAll(false)} className="text-blue-700 hover:underline dark:text-blue-300">None</button>
      </div>
      <ul className="max-h-56 overflow-auto rounded border border-gray-100 dark:border-gray-700">
        {shown.map(v => (
          <li key={v.value}>
            <label className="flex cursor-pointer items-center gap-1.5 px-2 py-0.5 hover:bg-gray-50 dark:hover:bg-gray-700/40">
              <input type="checkbox" checked={ticked.has(v.value)} onChange={() => toggle(v.value)} className="h-3 w-3" />
              <span className="flex-1 truncate text-gray-800 dark:text-gray-100">{v.label}</span>
              <span className="text-gray-600 dark:text-gray-400">{v.count}</span>
            </label>
          </li>
        ))}
        {shown.length === 0 && <li className="px-2 py-1 italic text-gray-600 dark:text-gray-400">No values</li>}
      </ul>
      {textColumn && (
        <label className="mt-1 block text-gray-700 dark:text-gray-300">
          Or contains
          <input value={contains} onChange={e => setContains(e.target.value)} placeholder="e.g. handler, lead" aria-label={`${column.label} contains`}
            className="mt-0.5 w-full rounded border border-gray-300 bg-white px-2 py-0.5 text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100" />
        </label>
      )}
      {column.type === 'knowledge' && (
        <label className="mt-1 flex items-center gap-1.5 text-gray-700 dark:text-gray-300">
          <input type="checkbox" checked={includeProposed} onChange={e => setIncludeProposed(e.target.checked)} className="h-3 w-3" />
          Count proposed (not yet confirmed) values
        </label>
      )}
      <div className="mt-2 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded border border-gray-300 px-2 py-0.5 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700">Cancel</button>
        <button type="button" onClick={apply} className="rounded bg-blue-600 px-2 py-0.5 text-white hover:bg-blue-700 dark:bg-blue-500">OK</button>
      </div>
    </div>
  );
}
