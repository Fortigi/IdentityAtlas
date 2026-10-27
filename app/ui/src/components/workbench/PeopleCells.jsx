import { useState } from 'react';
import { KIND_STYLE, STATE_LABEL, evidenceLine } from './workbench.labels';
import { cellValues } from './workbench.columns';
import ColumnFilterMenu from './ColumnFilterMenu';

// ─── The people columns: headers and one person's cells ─────────────────
// Frozen on the left while the access scrolls. Header: the column's name — click
// to sort (again to reverse) — and a filter button (▾, filled while a filter is
// on) that opens the Excel-like filter. Cells: the name (click: select what they
// hold; "member" once in the candidate; "2 accounts"), system data as text, and
// what is known of their work as chips — ✓ confirmed, ? proposed, ! disputed —
// that open their evidence (source, quote, who decided; Confirm / Reject), with
// "+" to state a new one.

// z-index by style: a cell whose popover is open rises above the frozen cells after it.
const STICKY = 'sticky border-b border-r border-gray-200 dark:border-gray-700';
const cellStyle = (column, left, z) => ({ left, zIndex: z, width: column.width, minWidth: column.width, maxWidth: column.width });

export function PeopleHeader({ columns, offsets, people, filters, sort, onSort, onFilter }) {
  const [open, setOpen] = useState(null);
  return columns.map((column, i) => {
    const filtered = !!filters[column.key];
    const sorted = sort?.key === column.key ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : '';
    return (
      <th key={column.key} scope="col" style={cellStyle(column, offsets[i], open === column.key ? 45 : 30)}
        className={`${STICKY} top-0 bg-gray-50 px-2 py-1 text-left align-bottom text-[11px] font-semibold text-gray-700 dark:bg-gray-900 dark:text-gray-200`}>
        <div className="relative flex items-center gap-1">
          <button type="button" onClick={() => onSort(column.key)} className="min-w-0 flex-1 truncate text-left hover:underline" title={`Sort by ${column.label}`}>
            {column.label}{sorted}
          </button>
          <button type="button" onClick={() => setOpen(open === column.key ? null : column.key)} aria-label={`Filter ${column.label}`} aria-expanded={open === column.key}
            className={`rounded px-1 ${filtered ? 'bg-blue-600 text-white dark:bg-blue-500' : 'text-gray-600 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-700'}`}>▾</button>
          {open === column.key && (
            <ColumnFilterMenu column={column} people={people} filter={filters[column.key]}
              onApply={(f) => { onFilter(column.key, f); setOpen(null); }} onClose={() => setOpen(null)} />
          )}
        </div>
      </th>
    );
  });
}

export function PersonCells({ person, columns, offsets, member, onSelectRow, onDecide, onAdd, knownNames, busy }) {
  const [open, setOpen] = useState(null);
  const [adding, setAdding] = useState(null);
  const bg = member ? 'bg-emerald-50 dark:bg-emerald-950' : 'bg-white dark:bg-gray-800';
  const add = async (kind, value) => { await onAdd(person, kind, value); setAdding(null); };
  return columns.map((column, i) => (
    <td key={column.key} style={cellStyle(column, offsets[i], open || adding ? 25 : 10)} className={`${STICKY} ${bg} px-2 py-0.5 align-top text-[11px] text-gray-800 dark:text-gray-200`}>
      <div className="relative">
        {column.type === 'name' && <NameCell person={person} member={member} onSelectRow={onSelectRow} />}
        {column.type === 'knowledge' && (
          <div className="flex flex-wrap items-center gap-0.5">
            {cellValues(person, column).map(v => (
              <Chip key={v.value} link={v.link} open={open === v.link} onToggle={() => setOpen(open === v.link ? null : v.link)} />
            ))}
            <button type="button" onClick={() => setAdding(adding === column.key ? null : column.key)} aria-label={`Add ${column.label.toLowerCase()} for ${person.displayName}`}
              className="rounded border border-dashed border-gray-300 px-1 text-[10px] leading-4 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700">+</button>
          </div>
        )}
        {(column.type === 'text' || column.type === 'multi' || column.type === 'count') && (
          <span className="block truncate" title={cellValues(person, column).map(v => v.label).join(', ')}>{cellValues(person, column).map(v => v.label).join(', ')}</span>
        )}
        {open && column.type === 'knowledge' && open.kind === column.key && <Evidence link={open} onDecide={onDecide} busy={busy} onClose={() => setOpen(null)} />}
        {adding === column.key && <AddLink person={person} kind={column.key} knownNames={knownNames} busy={busy} onAdd={add} onCancel={() => setAdding(null)} />}
      </div>
    </td>
  ));
}

function NameCell({ person, member, onSelectRow }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1">
      <button type="button" onClick={onSelectRow} className="truncate text-xs font-medium text-gray-900 hover:underline dark:text-gray-100" title="Select what this person holds">
        {person.displayName}
      </button>
      {member && <span className="text-[9px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">member</span>}
      <Accounts person={person} />
    </div>
  );
}

function Accounts({ person }) {
  const n = person.accounts.length;
  if (n <= 1) return null;
  const list = person.accounts.map(a => `${a.displayName || a.id}${a.systemName ? ` (${a.systemName})` : ''}`).join('\n');
  return <span className="shrink-0 rounded bg-gray-100 px-1 text-[9px] text-gray-700 dark:bg-gray-700 dark:text-gray-200" title={`Accounts:\n${list}`}>{n} accounts</span>;
}

const STATE_MARK = { confirmed: '✓', proposed: '?', disputed: '!' };

function Chip({ link, open, onToggle }) {
  const style = KIND_STYLE[link.kind];
  const dashed = link.state === 'confirmed' ? '' : 'border-dashed';
  const text = `${style.label}: ${link.name} — ${STATE_LABEL[link.state]}`;
  return (
    <button type="button" onClick={onToggle} aria-expanded={open} aria-label={text} title={text}
      className={`max-w-full truncate rounded border px-1 text-[10px] leading-4 ${style.cls} ${dashed}`}>
      <span aria-hidden="true">{STATE_MARK[link.state]} </span>{link.name}
    </button>
  );
}

const POPOVER = 'absolute left-0 top-full z-40 mt-1 w-72 rounded border border-gray-200 bg-white p-2 text-[11px] shadow-lg dark:border-gray-600 dark:bg-gray-900';

function Evidence({ link, onDecide, busy, onClose }) {
  const style = KIND_STYLE[link.kind];
  return (
    <div role="dialog" aria-label={`Evidence for ${link.name}`} className={POPOVER}>
      <div className="flex items-start justify-between gap-2">
        <div className="font-semibold text-gray-900 dark:text-gray-100">{style.label}: {link.name} <span className="font-normal text-gray-600 dark:text-gray-400">· {STATE_LABEL[link.state]}</span></div>
        <button type="button" onClick={onClose} aria-label="Close" className="text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100">✕</button>
      </div>
      <ul className="mt-1 space-y-1">
        {link.claims.map(c => (
          <li key={c.id} className="border-t border-gray-100 pt-1 dark:border-gray-700">
            <div className="text-gray-700 dark:text-gray-300">{evidenceLine(c)}</div>
            {c.quote && <blockquote className="mt-0.5 border-l-2 border-gray-300 pl-1 italic text-gray-600 dark:border-gray-600 dark:text-gray-400">“{c.quote}”</blockquote>}
            {c.status === 'proposed' && (
              <div className="mt-1 flex gap-2">
                <button type="button" disabled={busy} onClick={() => onDecide(c.id, 'confirmed')} className="rounded bg-blue-600 px-2 py-0.5 text-white hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-500">Confirm</button>
                <button type="button" disabled={busy} onClick={() => onDecide(c.id, 'rejected')} className="rounded border border-gray-300 px-2 py-0.5 text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700">Reject</button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function AddLink({ person, kind, knownNames, busy, onAdd, onCancel }) {
  const [value, setValue] = useState('');
  const listId = `wb-names-${kind}`;
  const submit = (e) => { e.preventDefault(); if (value.trim()) onAdd(kind, value.trim()); };
  return (
    <form onSubmit={submit} className={`${POPOVER} flex flex-wrap items-center gap-1`} aria-label={`Add for ${person.displayName}`}>
      <span className="text-gray-700 dark:text-gray-300">{KIND_STYLE[kind].label}</span>
      <input value={value} onChange={e => setValue(e.target.value)} list={listId} placeholder="e.g. Handle claims" aria-label="Name"
        className="w-36 rounded border border-gray-300 bg-white px-1 text-[11px] dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100" />
      <datalist id={listId}>{(knownNames[kind] || []).map(n => <option key={n} value={n} />)}</datalist>
      <button type="submit" disabled={busy || !value.trim()} className="rounded bg-blue-600 px-2 text-[11px] text-white disabled:opacity-50 dark:bg-blue-500">Add</button>
      <button type="button" onClick={onCancel} className="text-[11px] text-gray-600 hover:underline dark:text-gray-300">Cancel</button>
    </form>
  );
}
