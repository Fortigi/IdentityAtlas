import { useState } from 'react';
import { statusText } from './workbench.save';

// ─── Save and reopen (M2a) ───────────────────────────────────────────────
// One strip under the header: whether the work is saved (and as what), Save,
// Save as…, and Open… — the unit's saved investigations, each with who saved it,
// when, and when its access data was read. Opening one over unsaved work, and
// deleting one, ask first, inside the strip. When the access data changed since
// the investigation was saved, the strip says by how many cells.

const BTN = 'rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-800 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-100 dark:hover:bg-gray-700';
const PRIMARY = 'rounded bg-blue-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-500 dark:hover:bg-blue-400';
const FIELD = 'rounded border border-gray-300 bg-white px-1.5 py-0.5 text-xs dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100';

const when = (t) => (t ? new Date(t).toLocaleString() : '—');

export default function InvestigationBar({ inv }) {
  const [mode, setMode] = useState(null); // null | 'saveAs' | 'open'
  const close = () => setMode(null);
  return (
    <div className="space-y-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm dark:border-gray-700 dark:bg-gray-800">
      <div className="flex flex-wrap items-center gap-2">
        <span aria-live="polite" data-investigation-status="" className={`mr-auto text-xs ${inv.dirty ? 'font-medium text-amber-800 dark:text-amber-200' : 'text-gray-700 dark:text-gray-300'}`}>
          {statusText(inv)}
        </span>
        {inv.saved && <button type="button" className={PRIMARY} disabled={inv.busy || !inv.dirty} onClick={() => inv.save()}>Save</button>}
        <button type="button" className={inv.saved ? BTN : PRIMARY} disabled={inv.busy} onClick={() => setMode(m => (m === 'saveAs' ? null : 'saveAs'))}>
          {inv.saved ? 'Save as…' : 'Save…'}
        </button>
        <button type="button" className={BTN} disabled={inv.busy} aria-expanded={mode === 'open'}
          onClick={() => { if (mode !== 'open') inv.loadList(); setMode(m => (m === 'open' ? null : 'open')); }}>Open… ▾</button>
      </div>
      {inv.changedCells > 0 && (
        <p role="status" className="text-xs text-amber-800 dark:text-amber-200">
          Access read again since you saved: {inv.changedCells} {inv.changedCells === 1 ? 'cell differs' : 'cells differ'}. Your marks and proposed roles are kept as saved.
        </p>
      )}
      {inv.error && <p role="alert" className="text-xs text-red-700 dark:text-red-300">{inv.error}</p>}
      {mode === 'saveAs' && <SaveAsForm inv={inv} onDone={close} />}
      {mode === 'open' && <OpenList inv={inv} onDone={close} />}
    </div>
  );
}

function SaveAsForm({ inv, onDone }) {
  const [name, setName] = useState(inv.saved ? `${inv.saved.name} (copy)` : '');
  const submit = async (e) => {
    e.preventDefault();
    if (await inv.saveAs(name)) onDone();
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1 text-xs text-gray-700 dark:text-gray-300">
        Save as
        <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Motor handlers — first pass" aria-label="Investigation name" className={`w-72 ${FIELD}`} />
      </label>
      <button type="submit" className={PRIMARY} disabled={inv.busy || !name.trim()}>Save</button>
      <button type="button" className={BTN} onClick={onDone}>Cancel</button>
      <span className="text-[11px] text-gray-600 dark:text-gray-400">Saves the columns, filters, marks and every proposed role. Nothing changes access.</span>
    </form>
  );
}

function OpenList({ inv, onDone }) {
  const [confirm, setConfirm] = useState(null); // { kind: 'open'|'delete', id }
  if (inv.list === null) return <p className="text-xs text-gray-600 dark:text-gray-400">Loading…</p>;
  if (inv.list.length === 0) return <p className="text-xs text-gray-600 dark:text-gray-400">Nothing saved on this unit yet.</p>;
  const openIt = async (id) => {
    if (inv.dirty && confirm?.id !== id) { setConfirm({ kind: 'open', id }); return; }
    if (await inv.open(id)) onDone();
  };
  return (
    <ul aria-label="Saved investigations" className="divide-y divide-gray-100 rounded border border-gray-200 dark:divide-gray-700 dark:border-gray-700">
      {inv.list.map(item => (
        <li key={item.id} className="flex flex-wrap items-center gap-2 px-2 py-1.5">
          <div className="mr-auto min-w-0">
            <div className="text-sm font-medium text-gray-900 dark:text-white">{item.name}{inv.saved?.id === item.id ? ' · open now' : ''}</div>
            <div className="text-[11px] text-gray-600 dark:text-gray-400">
              {item.updatedBy}, {when(item.updatedAt)} · access as read {when(item.accessReadAt)} · {item.proposals.length} proposed {item.proposals.length === 1 ? 'role' : 'roles'} · {item.markCount} marks
            </div>
          </div>
          <ItemActions item={item} confirm={confirm} setConfirm={setConfirm} inv={inv} onOpen={openIt} />
        </li>
      ))}
    </ul>
  );
}

function ItemActions({ item, confirm, setConfirm, inv, onOpen }) {
  if (confirm?.id === item.id && confirm.kind === 'open') {
    return (
      <span className="flex items-center gap-1 text-xs text-amber-800 dark:text-amber-200">
        Your unsaved changes will be lost.
        <button type="button" className={PRIMARY} onClick={() => onOpen(item.id)}>Open anyway</button>
        <button type="button" className={BTN} onClick={() => setConfirm(null)}>Cancel</button>
      </span>
    );
  }
  if (confirm?.id === item.id && confirm.kind === 'delete') {
    return (
      <span className="flex items-center gap-1 text-xs text-red-700 dark:text-red-300">
        Delete “{item.name}” for everyone?
        <button type="button" className={BTN} onClick={async () => { await inv.remove(item.id); setConfirm(null); }}>Delete</button>
        <button type="button" className={BTN} onClick={() => setConfirm(null)}>Cancel</button>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1">
      <button type="button" className={BTN} disabled={inv.busy} onClick={() => onOpen(item.id)}>Open</button>
      <button type="button" className={BTN} disabled={inv.busy} onClick={() => setConfirm({ kind: 'delete', id: item.id })} aria-label={`Delete ${item.name}`}>Delete</button>
    </span>
  );
}
