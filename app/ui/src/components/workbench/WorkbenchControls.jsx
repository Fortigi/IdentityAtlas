import { useState } from 'react';
import { DIMENSIONS, MARKS, selectionParts } from './workbench.model';
import { PEOPLE_COLUMNS } from './workbench.columns';
import { MARK_LEGEND } from './workbench.cells';
import { MatrixLegendButton } from '@ui/components/matrix/GridCornerControls';
import { ORIENTATIONS, orientationOf } from './workbench.transposed';

// ─── The workbench's controls ────────────────────────────────────────────
// Toolbar: which people columns show, an optional grouping (off by default — one
// row per person), the unit's sub-units in or out, and which access columns show.
// Filter strip: "N of M people shown", the active filters, and what to do with the
// people shown. Selection bar: what is selected and what to do with it.

const BTN = 'rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-800 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-100 dark:hover:bg-gray-700';
const FIELD = 'rounded border border-gray-300 bg-white px-1 py-0.5 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100';

export function Toolbar({ view, setView }) {
  const set = (field) => (value) => setView(v => ({ ...v, [field]: value }));
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm dark:border-gray-700 dark:bg-gray-800">
      <OrientationSwitch view={view} onChange={set('orientation')} />
      <ColumnsChooser shown={view.columns} onChange={set('columns')} />
      {orientationOf(view) === 'rows' && (
        <label className="flex items-center gap-1 text-xs text-gray-700 dark:text-gray-300">
          Group by
          <select value={view.groupBy} onChange={e => set('groupBy')(e.target.value)} className={FIELD}>
            {DIMENSIONS.map(d => <option key={d.key} value={d.key}>{d.key === 'none' ? 'No grouping' : d.label}</option>)}
          </select>
        </label>
      )}
      <label className="flex items-center gap-1 text-xs text-gray-700 dark:text-gray-300">
        <input type="checkbox" checked={view.includeChildren} onChange={e => set('includeChildren')(e.target.checked)} />
        Include sub-units
      </label>
      <label className="flex items-center gap-1 text-xs text-gray-700 dark:text-gray-300">
        Access held by at least
        <input type="number" min={1} value={view.minHolders} onChange={e => set('minHolders')(Math.max(1, Number(e.target.value) || 1))} className={`w-12 ${FIELD}`} />
        people
      </label>
      <input type="search" value={view.columnSearch} onChange={e => set('columnSearch')(e.target.value)} placeholder="Find access…" aria-label="Find a column"
        className={`w-40 px-2 text-xs ${FIELD}`} />
    </div>
  );
}

// People as columns (the matrix's orientation, the default) or as rows. Saved with the view.
function OrientationSwitch({ view, onChange }) {
  const current = orientationOf(view);
  return (
    <div role="group" aria-label="Orientation" className="inline-flex overflow-hidden rounded border border-gray-300 text-xs dark:border-gray-600">
      {ORIENTATIONS.map(o => (
        <button key={o.key} type="button" onClick={() => onChange(o.key)} aria-pressed={current === o.key}
          className={`px-2 py-0.5 ${current === o.key ? 'bg-blue-600 text-white dark:bg-blue-500' : 'text-gray-800 hover:bg-gray-50 dark:text-gray-100 dark:hover:bg-gray-700'}`}>{o.label}</button>
      ))}
    </div>
  );
}

// The people columns to show: name always, then any of system data and knowledge.
function ColumnsChooser({ shown, onChange }) {
  const [open, setOpen] = useState(false);
  const toggle = (key) => onChange(PEOPLE_COLUMNS.filter(c => c.fixed || (c.key === key ? !shown.includes(key) : shown.includes(c.key))).map(c => c.key));
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} className={BTN}>Columns ▾</button>
      {open && (
        <div role="dialog" aria-label="Columns" className="absolute left-0 top-full z-50 mt-1 w-56 rounded-md border border-gray-200 bg-white p-2 text-xs shadow-lg dark:border-gray-600 dark:bg-gray-800">
          {PEOPLE_COLUMNS.filter(c => !c.fixed).map(c => (
            <label key={c.key} className="flex items-center gap-1.5 py-0.5 text-gray-800 dark:text-gray-100">
              <input type="checkbox" checked={shown.includes(c.key)} onChange={() => toggle(c.key)} className="h-3 w-3" />{c.label}
            </label>
          ))}
          <button type="button" onClick={() => setOpen(false)} className="mt-1 text-blue-700 hover:underline dark:text-blue-300">Done</button>
        </div>
      )}
    </div>
  );
}

// "8 of 26 people shown", the filters in words (each removable), and the Excel move:
// take the people the filters leave.
export function FilterStrip({ shown, total, summary, onClear, onClearAll, onSelectShown, onAddShown, onUseAsRule }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs" role="region" aria-label="Filters">
      <span className="font-medium text-gray-900 dark:text-gray-100">{shown} of {total} people shown</span>
      {summary.map(s => (
        <span key={s.key} className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-blue-900 dark:bg-blue-900/40 dark:text-blue-100">
          {s.text}
          <button type="button" onClick={() => onClear(s.key)} aria-label={`Clear the filter ${s.text}`} className="hover:text-red-600">✕</button>
        </span>
      ))}
      {summary.length > 0 && <button type="button" onClick={onClearAll} className="text-blue-700 hover:underline dark:text-blue-300">Clear all filters</button>}
      <span className="ml-auto flex gap-2">
        <button type="button" onClick={onSelectShown} disabled={shown === 0} className={`${BTN} disabled:opacity-50`}>Select what they hold</button>
        {onUseAsRule && <button type="button" onClick={onUseAsRule} title="The role's members follow these filters (and the sub-units choice), now and as people join or leave" className={BTN}>Use these filters as the role's rule</button>}
        <button type="button" onClick={onAddShown} disabled={shown === 0} className="rounded bg-emerald-600 px-2 py-0.5 text-white hover:bg-emerald-700 disabled:opacity-50 dark:bg-emerald-500">Add the {shown} shown as members</button>
      </span>
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