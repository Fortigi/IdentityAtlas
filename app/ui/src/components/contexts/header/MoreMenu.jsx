import { usePopover } from '@ui/components/matrix/usePopover';
import { useDialog } from '@ui/components/dialogContext';
import { AdjustTreeMenuItem } from '@ui/components/adjustTree/AdjustTreeAction';
import { matrixHrefForUnit } from '@ui/utils/matrixFilter';

// ─── The header's ⋯ menu: everything but the main actions ────────────────
// Each item only when its handler (or flag) is given, in this order:
//   matrix        View in matrix ↗ (a new tab; not in a read-only shell)
//   onAdjustTree  Adjust tree (the API says whether this tree can be adjusted, once the menu is open)
//   onEditRecipe  Edit search terms (a recipe root, for whoever may build contexts)
//   onEdit        Edit (name, description, parent, template, delete)
//   onAddSubUnit  Add sub-unit
//   copyLink      Copy link (not in a read-only shell: its URL is not this unit's page)
//   onOpenAsPage  Open as page (embedded in the Contexts page)
//   onClose       Back to Contexts (the standalone page, for the analyst)
// The first item takes the focus when the menu opens; Escape closes it.
// Nothing renders when there is nothing to offer.

const ITEM = 'block w-full px-3 py-1.5 text-left text-sm text-gray-800 hover:bg-gray-100 focus:bg-gray-100 focus:outline-none dark:text-gray-200 dark:hover:bg-gray-700 dark:focus:bg-gray-700';

function contextLink(id) {
  const { origin, pathname } = window.location;
  return `${origin}${pathname}#context:${id}`;
}

export default function MoreMenu({ attrs, matrix, onAdjustTree, onEditRecipe, onEdit, onAddSubUnit, copyLink, onOpenAsPage, onClose }) {
  const { open, toggle, close, triggerRef, panelRef } = usePopover();
  const dialog = useDialog();

  async function copy() {
    close();
    try {
      await navigator.clipboard.writeText(contextLink(attrs.id));
      dialog.toast('Link copied', { variant: 'success' });
    } catch {
      dialog.alert('Could not copy the link');
    }
  }
  const run = (fn) => () => { close(); fn(); };

  const items = [
    matrix && (first => (
      <a key="matrix" role="menuitem" href={matrixHrefForUnit(attrs)} target="_blank" rel="noopener noreferrer" data-autofocus={first || undefined}
        onClick={close} className={ITEM} title="Opens in a new tab">View in matrix ↗</a>
    )),
    onAdjustTree && (first => <AdjustTreeMenuItem key="adjust" contextId={attrs.id} className={ITEM} autoFocus={first} onDone={close} onOpen={onAdjustTree} />),
    onEditRecipe && (first => <button key="recipe" type="button" role="menuitem" data-autofocus={first || undefined} onClick={run(onEditRecipe)} className={ITEM}>Edit search terms</button>),
    onEdit && (first => <button key="edit" type="button" role="menuitem" data-autofocus={first || undefined} onClick={run(onEdit)} className={ITEM}>Edit</button>),
    onAddSubUnit && (first => <button key="sub" type="button" role="menuitem" data-autofocus={first || undefined} onClick={run(onAddSubUnit)} className={ITEM}>Add sub-unit</button>),
    copyLink && (first => <button key="copy" type="button" role="menuitem" data-autofocus={first || undefined} onClick={copy} className={ITEM}>Copy link</button>),
    onOpenAsPage && (first => <button key="page" type="button" role="menuitem" data-autofocus={first || undefined} onClick={run(onOpenAsPage)} className={ITEM} title="Open this unit in its own tab">Open as page</button>),
    onClose && (first => <button key="back" type="button" role="menuitem" data-autofocus={first || undefined} onClick={run(onClose)} className={ITEM}>Back to Contexts</button>),
  ].filter(Boolean);
  if (items.length === 0) return null;

  return (
    <div className="relative">
      <button ref={triggerRef} type="button" onClick={toggle} aria-haspopup="menu" aria-expanded={open} aria-label="More actions" title="More actions"
        className="flex h-8 w-9 items-center justify-center rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700/50 dark:focus-visible:ring-blue-400">
        <span aria-hidden="true">⋯</span>
      </button>
      {open && (
        <div ref={panelRef} role="menu" aria-label="More actions"
          className="absolute right-0 top-full z-50 mt-1 min-w-[12rem] rounded border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-600 dark:bg-gray-800">
          {items.map((item, i) => item(i === 0))}
        </div>
      )}
    </div>
  );
}
