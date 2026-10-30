import { contextSubtitle } from '@ui/utils/contextStyles';
import { useCanBuildContexts } from '@ui/hooks/useCanBuildContexts';
import { useDialog } from '@ui/components/dialogContext';
import { isRecipeRoot } from './contexts/assistant/recipeDraft';
import ContextOwner from './contexts/ContextOwner';
import ContextAccessCounts from './contexts/ContextAccessCounts';
import { useContextAncestors } from './contexts/useContextAncestors';

// ─── Header: the name, one sentence on what it is, and the page actions ──
// The sentence ("Department · imported from Fortigi Demo HR") replaces the
// old row of classification badges; the raw values sit under More details for
// whoever can edit. Above the name, the parents as a breadcrumb.
//
// Actions, each only when its handler is given:
//   onEdit        Edit (name, description, parent, template, delete)
//   onAddSubUnit  Add sub-unit
//   onOpenAsPage  Open as page (embedded in the Contexts page)
//   onClose       Back to Contexts (the page opened from the tree)
// Copy link is always offered: the page URL is the link to share.

const SECONDARY_BTN = 'rounded bg-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600 whitespace-nowrap';
const OUTLINE_BTN = 'rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-700/50 whitespace-nowrap';

function contextLink(id) {
  const { origin, pathname } = window.location;
  return `${origin}${pathname}#context:${id}`;
}

export default function ContextDetailHeader({ attrs, onClose, onOpenDetail, onOpenAsPage, onEdit, onAddSubUnit }) {
  const canEditRecipe = useCanBuildContexts() && isRecipeRoot(attrs) && !!onOpenDetail;
  const subtitle = contextSubtitle(attrs);

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Breadcrumb attrs={attrs} onOpenDetail={onOpenDetail} />
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white truncate">{attrs.displayName || attrs.id}</h2>
            <ContextOwner attrs={attrs} onOpenDetail={onOpenDetail} />
          </div>
          {subtitle && <p data-testid="context-subtitle" className="text-sm text-gray-600 dark:text-gray-400 mt-1">{subtitle}</p>}
          <ContextAccessCounts attrs={attrs} />
        </div>
        <div className="flex flex-wrap items-start gap-2">
          {canEditRecipe && (
            <button type="button" onClick={() => onOpenDetail('context-builder', attrs.id, attrs.displayName)} className={SECONDARY_BTN}>
              Edit search terms
            </button>
          )}
          {onEdit && <button type="button" onClick={onEdit} className={SECONDARY_BTN}>Edit</button>}
          {onAddSubUnit && <button type="button" onClick={onAddSubUnit} className={SECONDARY_BTN}>Add sub-unit</button>}
          <CopyLinkButton id={attrs.id} />
          {onOpenAsPage && (
            <button type="button" onClick={onOpenAsPage} className={OUTLINE_BTN} title="Open this unit in its own tab">
              Open as page
            </button>
          )}
          {onClose && <button type="button" onClick={onClose} className={OUTLINE_BTN}>Back to Contexts</button>}
        </div>
      </div>
    </div>
  );
}

// The parents above this context, root first, each opening its own page.
function Breadcrumb({ attrs, onOpenDetail }) {
  const ancestors = useContextAncestors(attrs);
  if (ancestors.length === 0) return null;
  return (
    <nav aria-label="Breadcrumb" className="mb-1">
      <ol className="flex flex-wrap items-center gap-1 text-sm text-gray-600 dark:text-gray-400">
        {ancestors.map(a => (
          <li key={a.id} className="flex items-center gap-1">
            {onOpenDetail
              ? <button type="button" onClick={() => onOpenDetail('context', a.id, a.displayName)} className="hover:underline hover:text-blue-700 dark:hover:text-blue-300">{a.displayName}</button>
              : <span>{a.displayName}</span>}
            <span aria-hidden="true">›</span>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function CopyLinkButton({ id }) {
  const dialog = useDialog();
  async function copy() {
    try {
      await navigator.clipboard.writeText(contextLink(id));
      dialog.toast('Link copied', { variant: 'success' });
    } catch {
      dialog.alert('Could not copy the link');
    }
  }
  return <button type="button" onClick={copy} className={OUTLINE_BTN} title="Copy the link to this page">Copy link</button>;
}
