import { usePopover } from '@ui/components/matrix/usePopover';
import { useDialog } from '@ui/components/dialogContext';

// The actions on one whole tree, in a ⋯ menu on its root row: Refresh (derived
// trees only — it re-runs the rule; renames, moves and members added by hand
// are kept) and "Delete this tree…". The page renders the menu only on trees
// the user may change, so an imported tree (the next import would bring it
// back; the API refuses) never shows it.

const ITEM_CLASS = 'block w-full px-3 py-1.5 text-left text-xs hover:bg-gray-100 focus:bg-gray-100 focus:outline-none dark:hover:bg-gray-700 dark:focus:bg-gray-700 disabled:opacity-50';

// `label` names the tree in the menu's accessible name when its display name
// alone is ambiguous ("Tags · People" beside "Tags · Accounts").
export default function TreeRootMenu({ root, label, onRefresh, refreshing, onDelete }) {
  const { open, toggle, close, triggerRef, panelRef } = usePopover();
  const dialog = useDialog();
  const canRefresh = root.variant === 'generated';
  const name = label || root.displayName;

  async function confirmDelete() {
    close();
    const ok = await dialog.confirm({
      title: 'Delete this tree',
      message: `Delete "${name}" and every unit under it? Its ${root.totalMemberCount ?? 0} members are not deleted, only their place in this tree. This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (ok) onDelete(root.id);
  }

  return (
    <div className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${name}`}
        title="Actions for this tree"
        className="w-6 h-6 flex items-center justify-center rounded text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 dark:focus-visible:ring-blue-400"
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open && (
        <div ref={panelRef} role="menu" aria-label={`Actions for ${name}`}
          className="absolute right-0 top-full z-50 mt-1 min-w-[11rem] rounded border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-600 dark:bg-gray-800">
          {canRefresh && (
            <button
              type="button" role="menuitem" data-autofocus disabled={refreshing}
              onClick={() => { close(); onRefresh(root.id); }}
              title="Run the rule again to update the tree — renames, moves and members added by hand are kept"
              className={`${ITEM_CLASS} text-gray-800 dark:text-gray-200`}
            >{refreshing ? 'Refreshing…' : 'Refresh'}</button>
          )}
          <button
            type="button" role="menuitem" data-autofocus={canRefresh ? undefined : true}
            onClick={confirmDelete}
            className={`${ITEM_CLASS} text-red-700 dark:text-red-400`}
          >Delete this tree…</button>
        </div>
      )}
    </div>
  );
}

// What the tree actions report back, above the trees: a refresh in progress or
// done, and an edit or delete the API refused.
export function TreeStatus({ syncing, syncMsg, errors }) {
  const shown = (errors || []).filter(Boolean);
  if (!syncing && !syncMsg && shown.length === 0) return null;
  return (
    <div className="mx-3 mt-2 space-y-1 text-xs" role="status">
      {syncing && <div className="text-gray-600 dark:text-gray-400">Refreshing the tree…</div>}
      {syncMsg && <div className="text-green-700 dark:text-green-400">{syncMsg === 'Synced' ? 'Refreshed' : syncMsg}</div>}
      {shown.map(e => (
        <div key={e} className="text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded px-2 py-1">{e}</div>
      ))}
    </div>
  );
}
