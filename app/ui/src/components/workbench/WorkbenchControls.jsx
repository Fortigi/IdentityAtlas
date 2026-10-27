import { DIMENSIONS, MARKS, selectionParts } from './workbench.model';
import { MARK_LEGEND } from './workbench.cells';
import { MatrixLegendButton } from '@ui/components/matrix/GridCornerControls';

// ─── The workbench's controls ────────────────────────────────────────────
// Toolbar: group by (Activity / Expertise / Duty / Job title / none), sort, the
// unit's sub-units in or out, and a column filter. Selection
// bar: what is selected and what to do with it. Legend: every glyph in words.

const SORTS = [{ key: 'name', label: 'Name' }, { key: 'access', label: 'Most access' }, { key: 'jobTitle', label: 'Job title' }];

export function Toolbar({ view, setView }) {
  const set = (field) => (value) => setView(v => ({ ...v, [field]: value }));
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm dark:border-gray-700 dark:bg-gray-800">
      <div role="radiogroup" aria-label="Group people by" className="flex items-center gap-1">
        <span className="mr-1 text-xs text-gray-600 dark:text-gray-400">Group by</span>
        {DIMENSIONS.map(d => (
          <button key={d.key} type="button" role="radio" aria-checked={view.groupBy === d.key} onClick={() => set('groupBy')(d.key)}
            className={`rounded px-2 py-0.5 text-xs ${view.groupBy === d.key ? 'bg-blue-600 text-white dark:bg-blue-500' : 'border border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700'}`}>
            {d.label}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-1 text-xs text-gray-700 dark:text-gray-300">
        Show people with several values
        <select value={view.multi} onChange={e => set('multi')(e.target.value)} disabled={view.groupBy === 'none'}
          className="rounded border border-gray-300 bg-white px-1 py-0.5 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100">
          <option value="each">in each group</option>
          <option value="once">once (strongest)</option>
        </select>
      </label>
      <label className="flex items-center gap-1 text-xs text-gray-700 dark:text-gray-300">
        Sort
        <select value={view.sortBy} onChange={e => set('sortBy')(e.target.value)} className="rounded border border-gray-300 bg-white px-1 py-0.5 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100">
          {SORTS.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-1 text-xs text-gray-700 dark:text-gray-300">
        <input type="checkbox" checked={view.includeChildren} onChange={e => set('includeChildren')(e.target.checked)} />
        Include sub-units
      </label>
      <label className="flex items-center gap-1 text-xs text-gray-700 dark:text-gray-300">
        Columns held by at least
        <input type="number" min={1} value={view.minHolders} onChange={e => set('minHolders')(Math.max(1, Number(e.target.value) || 1))}
          className="w-12 rounded border border-gray-300 bg-white px-1 py-0.5 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100" />
        people
      </label>
      <input type="search" value={view.columnSearch} onChange={e => set('columnSearch')(e.target.value)} placeholder="Find a column…" aria-label="Find a column"
        className="w-40 rounded border border-gray-300 bg-white px-2 py-0.5 text-xs dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100" />

    </div>
  );
}

// How many of the selected people appear in more than one group on screen.
function repeatedPeople(groups, people) {
  const seen = new Map();
  for (const g of groups) for (const r of g.rows) if (people.has(r.person.key)) seen.set(r.person.key, (seen.get(r.person.key) ?? 0) + 1);
  return [...seen.values()].filter(n => n > 1).length;
}

export function SelectionBar({ selection, dispatch, cellIndex, groups = [] }) {
  const { people, resources } = selectionParts(selection);
  const repeated = repeatedPeople(groups, people);
  if (selection.size === 0) {
    return <p className="text-xs text-gray-600 dark:text-gray-400">Click a cell, Shift-click for a rectangle, Ctrl/⌘-click to add; click a person, a group or a column header to select what they hold.</p>;
  }
  const btn = 'rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-800 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-100 dark:hover:bg-gray-700';
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 dark:border-blue-800 dark:bg-blue-950/50" role="toolbar" aria-label="Selection">
      <span className="text-xs font-medium text-blue-900 dark:text-blue-100">
        {selection.size} cell{selection.size === 1 ? '' : 's'} · {people.size} {people.size === 1 ? 'person' : 'people'} · {resources.size} column{resources.size === 1 ? '' : 's'}
        {repeated > 0 && <span className="font-normal"> · each counted once ({repeated} shown in more than one group)</span>}
      </span>
      <button type="button" onClick={() => dispatch({ type: 'addSelection', cellIndex })} className="rounded bg-emerald-600 px-2 py-0.5 text-xs text-white hover:bg-emerald-700 dark:bg-emerald-500">Add to candidate</button>
      <button type="button" onClick={() => dispatch({ type: 'addMembers', people: [...people] })} className={btn}>Members only</button>
      {Object.entries(MARKS).map(([k, m]) => (
        <button key={k} type="button" title={m.hint} onClick={() => dispatch({ type: 'mark', mark: k })} className={btn}>Mark: {m.label}</button>
      ))}
      <button type="button" onClick={() => dispatch({ type: 'mark', mark: null })} className={btn}>Clear mark</button>
      <button type="button" onClick={() => dispatch({ type: 'clearSelection' })} className="text-xs text-blue-800 hover:underline dark:text-blue-200">Clear selection</button>
    </div>
  );
}

// Legend: the matrix's own (badges, role colours, the marker strip — the same
// MatrixLegend the matrix opens), then the marks only the workbench has.
export function Legend() {
  return (
    <div aria-label="Legend" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-gray-700 dark:text-gray-300">
      <MatrixLegendButton />
      <span>Colour = covered by a business role · the candidate shows as <span className="font-medium">Draft</span> in the role band</span>
      <ul aria-label="Marks" className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {MARK_LEGEND.map(s => (
          <li key={s.key} className="flex items-center gap-1">
            <span aria-hidden="true" className={`inline-flex h-3 min-w-[0.75rem] items-center justify-center rounded-sm px-0.5 text-[8px] font-bold ${s.mark}`}>{s.glyph}</span>{s.label}
          </li>
        ))}
      </ul>
    </div>
  );
}