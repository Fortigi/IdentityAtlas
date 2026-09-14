// The dropdown of org-wide saved matrices (#768/#1202), in two guises.
//
// On the strip above the matrix it is the NAME MENU: its trigger is the name of
// the matrix on screen ("Unsaved matrix" when it is none), it marks that one in
// the list, and it carries the document verbs — New matrix…, and for the current
// saved matrix Rename…, Duplicate… and Delete…. Pass `triggerLabel` for this.
// Inside the wizard it is still a plain "Saved matrices (n)" loader with a Delete
// per row. One component, so the list, the shared markers and the delete warning
// can't differ between the two.
//
// Deleting one is an org-wide act, and deleting a SHARED one also closes the
// link its recipients hold — so the confirmation names them rather than
// mentioning it afterwards.

import { useEffect, useRef, useState } from 'react';
import { useDialog } from '@ui/components/dialogContext';
import { sharedWithLabel } from './shareState';

// Asks before deleting; resolves true when the analyst confirmed.
function confirmDeleteSavedMatrix(dialog, row) {
  return dialog.confirm({
    title: 'Delete this saved matrix?',
    message: row.shared
      ? `"${row.name}" is shared. ${sharedWithLabel(row.recipientCount)} — deleting it stops their link working. This affects everyone in the org.`
      : `"${row.name}" is visible to everyone in the org, and deleting it affects them all.`,
    confirmLabel: 'Delete matrix',
    danger: true,
  });
}

const ITEM = 'block w-full px-3 py-1.5 text-left text-xs hover:bg-gray-50 dark:hover:bg-gray-700/50';

function SavedMatrixRow({ row, isCurrent, onPick, onDelete }) {
  return (
    <li className="flex items-center justify-between gap-2 px-2 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-700/50">
      <button
        type="button"
        onClick={() => onPick(row.id)}
        aria-current={isCurrent ? 'true' : undefined}
        className="flex min-w-0 flex-1 items-start gap-1.5 text-left text-xs text-gray-800 dark:text-gray-200"
        title={row.description || row.name}
      >
        <span aria-hidden="true" className="w-3 shrink-0 text-blue-700 dark:text-blue-300">{isCurrent ? '✓' : ''}</span>
        <span className="min-w-0">
          <span className={`block truncate ${isCurrent ? 'font-semibold' : ''}`}>{row.name}</span>
          {row.shared && (
            <span className="block text-[10px] text-blue-700 dark:text-blue-300">{sharedWithLabel(row.recipientCount)}</span>
          )}
        </span>
      </button>
      {onDelete && (
        <button
          type="button"
          onClick={() => onDelete(row)}
          className="text-[10px] text-gray-600 hover:text-red-600 dark:text-gray-400 dark:hover:text-red-400"
          title="Delete (org-wide)"
        >
          Delete
        </button>
      )}
    </li>
  );
}

// The name menu's verbs: New matrix… always; the rest act on the current saved
// matrix, so they only appear when there is one.
function DocumentActions({ current, onNew, onRename, onDuplicate, onDelete, close }) {
  const act = (fn) => () => { close(); fn(); };
  const plain = `${ITEM} text-gray-800 dark:text-gray-200`;
  return (
    <div className="border-t border-gray-200 py-1 dark:border-gray-700">
      <button type="button" className={plain} onClick={act(onNew)}>New matrix…</button>
      {current && (
        <>
          <button type="button" className={plain} onClick={act(() => onRename(current))}>Rename…</button>
          <button type="button" className={plain} onClick={act(() => onDuplicate(current))}>Duplicate…</button>
          <button type="button" className={`${ITEM} text-red-700 dark:text-red-300`} onClick={act(() => onDelete(current))}>Delete…</button>
        </>
      )}
    </div>
  );
}

export default function SavedMatrixMenu({
  savedFilters, onLoad, onDelete, label = 'Load matrix',
  triggerLabel, currentId = null, onNew, onRename, onDuplicate,
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const dialog = useDialog();
  const nameMenu = triggerLabel != null;

  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  async function confirmDelete(row) {
    if (await confirmDeleteSavedMatrix(dialog, row)) onDelete(row.id);
  }

  const close = () => setOpen(false);
  const current = savedFilters.find(f => f.id === currentId) || null;

  return (
    <div ref={ref} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className={nameMenu
          ? 'inline-flex max-w-[36ch] items-center gap-1 rounded px-1.5 py-1 text-sm font-semibold text-gray-900 hover:bg-blue-100/60 dark:text-gray-100 dark:hover:bg-blue-900/30'
          : 'rounded border border-gray-200 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700/50'}
      >
        <span className="truncate">{nameMenu ? triggerLabel : `${label} (${savedFilters.length})`}</span>
        <span aria-hidden="true"> ▾</span>
      </button>
      {open && (
        // z-50: above the grid's sticky header cells (z-40), which otherwise
        // paint over the list — same layer as the Export menu and legend popover.
        <div className="absolute left-0 top-full z-50 mt-1 w-80 rounded border border-gray-200 bg-white shadow-lg dark:border-gray-600 dark:bg-gray-800">
          {savedFilters.length === 0 ? (
            <div className="px-3 py-2 text-xs italic text-gray-600 dark:text-gray-400">No saved matrices yet</div>
          ) : (
            <ul className="max-h-72 overflow-y-auto" aria-label="Saved matrices">
              {savedFilters.map(f => (
                <SavedMatrixRow
                  key={f.id}
                  row={f}
                  isCurrent={f.id === currentId}
                  onPick={(id) => { onLoad(id); close(); }}
                  onDelete={nameMenu ? null : confirmDelete}
                />
              ))}
            </ul>
          )}
          {nameMenu && (
            <DocumentActions current={current} onNew={onNew} onRename={onRename} onDuplicate={onDuplicate} onDelete={confirmDelete} close={close} />
          )}
        </div>
      )}
    </div>
  );
}
