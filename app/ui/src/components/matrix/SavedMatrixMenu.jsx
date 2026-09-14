// "Load a saved matrix" — the dropdown of org-wide saved matrices (#768/#1202).
//
// Loading used to be buried inside the wizard. It is a first-class control on
// the matrix bar now, and the wizard renders the same component, so the list,
// the shared markers and the delete warning can't differ between the two.
//
// Deleting one is an org-wide act, and deleting a SHARED one also closes the
// link its recipients hold — so the confirmation names them rather than
// mentioning it afterwards.

import { useEffect, useRef, useState } from 'react';
import { useDialog } from '@ui/components/dialogContext';
import { sharedWithLabel } from './shareState';

export default function SavedMatrixMenu({ savedFilters, onLoad, onDelete, label = 'Load matrix' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const dialog = useDialog();

  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  async function confirmDelete(row) {
    const ok = await dialog.confirm({
      title: 'Delete this saved matrix?',
      message: row.shared
        ? `"${row.name}" is shared. ${sharedWithLabel(row.recipientCount)} — deleting it stops their link working. This affects everyone in the org.`
        : `"${row.name}" is visible to everyone in the org, and deleting it affects them all.`,
      confirmLabel: 'Delete matrix',
      danger: true,
    });
    if (ok) onDelete(row.id);
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700/50"
      >
        {label} ({savedFilters.length}) ▾
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 max-h-80 w-80 overflow-y-auto rounded border border-gray-200 bg-white shadow-lg dark:border-gray-600 dark:bg-gray-800">
          {savedFilters.length === 0 ? (
            <div className="px-3 py-2 text-xs italic text-gray-600 dark:text-gray-400">No saved matrices yet</div>
          ) : (
            savedFilters.map(f => (
              <div key={f.id} className="flex items-center justify-between gap-2 px-2 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-700/50">
                <button
                  type="button"
                  onClick={() => { onLoad(f.id); setOpen(false); }}
                  className="min-w-0 flex-1 text-left text-xs text-gray-800 dark:text-gray-200"
                  title={f.description || f.name}
                >
                  <span className="block truncate">{f.name}</span>
                  {f.shared && (
                    <span className="block text-[10px] text-blue-700 dark:text-blue-300">
                      {sharedWithLabel(f.recipientCount)}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => confirmDelete(f)}
                  className="text-[10px] text-gray-600 hover:text-red-600 dark:text-gray-400 dark:hover:text-red-400"
                  title="Delete (org-wide)"
                >
                  Delete
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
