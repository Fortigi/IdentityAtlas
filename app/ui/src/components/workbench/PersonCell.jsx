import { useState } from 'react';
import { KIND_STYLE, STATE_LABEL, evidenceLine } from './workbench.labels';

// ─── One person's row header ─────────────────────────────────────────────
// A repeat appearance (a person with several values, shown again in another
// group) is dimmed and says where else they are.
// Name (click: select what they hold), job title, how many accounts, and what is
// said they do, know and hold — one chip per link, in the kind's colour, its
// status in words and a mark (✓ confirmed, ? proposed, ! disputed). A chip opens
// its evidence: every claim, its source and quote, who decided it, and Confirm /
// Reject for a proposed one. "+" states a new one (an analyst's own claim).

export default function PersonCell({ person, alsoUnder = [], repeat = false, member, onSelectRow, onDecide, onAdd, knownNames, busy }) {
  const [open, setOpen] = useState(null);
  const [adding, setAdding] = useState(false);
  const links = person.knowledge || [];
  return (
    <th scope="row" className={`sticky left-0 z-10 min-w-[16rem] max-w-[22rem] border-b border-r border-gray-200 px-3 py-1 text-left align-top font-normal dark:border-gray-700 ${member ? 'bg-emerald-50 dark:bg-emerald-950' : 'bg-white dark:bg-gray-800'}`}>
      <div className="flex items-baseline gap-2">
        <button type="button" onClick={onSelectRow} className="truncate text-sm font-medium text-gray-900 hover:underline dark:text-gray-100" title="Select what this person holds">
          {person.displayName}
        </button>
        {member && <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">member</span>}
        <Accounts person={person} />
        {repeat && <span className="text-[10px] italic text-gray-600 dark:text-gray-400" title="The same person, shown again: they have several values here">also under: {alsoUnder.join(', ')}</span>}
      </div>
      {person.jobTitle && <div className="truncate text-[11px] text-gray-600 dark:text-gray-400">{person.jobTitle}</div>}
      <div className="mt-0.5 flex flex-wrap items-center gap-1">
        {links.filter(l => l.state !== 'rejected').map(l => (
          <Chip key={`${l.kind}:${l.name}`} link={l} open={open === l} onToggle={() => setOpen(open === l ? null : l)} />
        ))}
        <button type="button" onClick={() => setAdding(a => !a)} aria-label={`Add what ${person.displayName} does, knows or holds`}
          className="rounded border border-dashed border-gray-300 px-1 text-[10px] text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700">+</button>
      </div>
      {open && <Evidence link={open} onDecide={onDecide} busy={busy} onClose={() => setOpen(null)} />}
      {adding && <AddLink person={person} knownNames={knownNames} busy={busy} onAdd={async (kind, value) => { await onAdd(person, kind, value); setAdding(false); }} onCancel={() => setAdding(false)} />}
    </th>
  );
}

function Accounts({ person }) {
  const n = person.accounts.length;
  if (n <= 1) return null;
  const list = person.accounts.map(a => `${a.displayName || a.id}${a.systemName ? ` (${a.systemName})` : ''}`).join('\n');
  return <span className="rounded bg-gray-100 px-1 text-[10px] text-gray-700 dark:bg-gray-700 dark:text-gray-200" title={`Accounts:\n${list}`}>{n} accounts</span>;
}

const STATE_MARK = { confirmed: '✓', proposed: '?', disputed: '!' };

function Chip({ link, open, onToggle }) {
  const style = KIND_STYLE[link.kind];
  const dashed = link.state === 'confirmed' ? '' : 'border-dashed';
  return (
    <button type="button" onClick={onToggle} aria-expanded={open}
      aria-label={`${style.label}: ${link.name} — ${STATE_LABEL[link.state]}`}
      title={`${style.label}: ${link.name} — ${STATE_LABEL[link.state]}`}
      className={`max-w-[12rem] truncate rounded border px-1 text-[10px] leading-4 ${style.cls} ${dashed}`}>
      <span aria-hidden="true">{STATE_MARK[link.state]} </span>{link.name}
    </button>
  );
}

function Evidence({ link, onDecide, busy, onClose }) {
  const style = KIND_STYLE[link.kind];
  return (
    <div role="dialog" aria-label={`Evidence for ${link.name}`} className="mt-1 rounded border border-gray-200 bg-white p-2 text-[11px] shadow-sm dark:border-gray-600 dark:bg-gray-900">
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

function AddLink({ person, knownNames, busy, onAdd, onCancel }) {
  const [kind, setKind] = useState('activity');
  const [value, setValue] = useState('');
  const listId = `wb-names-${kind}`;
  const submit = (e) => { e.preventDefault(); if (value.trim()) onAdd(kind, value.trim()); };
  return (
    <form onSubmit={submit} className="mt-1 flex flex-wrap items-center gap-1 rounded border border-gray-200 p-1 dark:border-gray-600" aria-label={`Add for ${person.displayName}`}>
      <select value={kind} onChange={e => setKind(e.target.value)} aria-label="Kind" className="rounded border border-gray-300 bg-white px-1 text-[11px] dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100">
        {Object.entries(KIND_STYLE).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
      </select>
      <input value={value} onChange={e => setValue(e.target.value)} list={listId} placeholder="e.g. Handle claims" aria-label="Name"
        className="w-32 rounded border border-gray-300 bg-white px-1 text-[11px] dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100" />
      <datalist id={listId}>{(knownNames[kind] || []).map(n => <option key={n} value={n} />)}</datalist>
      <button type="submit" disabled={busy || !value.trim()} className="rounded bg-blue-600 px-2 text-[11px] text-white disabled:opacity-50 dark:bg-blue-500">Add</button>
      <button type="button" onClick={onCancel} className="text-[11px] text-gray-600 hover:underline dark:text-gray-300">Cancel</button>
    </form>
  );
}
