import { contextSubtitle } from '@ui/utils/contextStyles';
import { useCanBuildContexts } from '@ui/hooks/useCanBuildContexts';
import { isRecipeRoot } from './contexts/assistant/recipeDraft';
import ContextAccessCounts from './contexts/ContextAccessCounts';
import { useContextAncestors } from './contexts/useContextAncestors';
import { useIsSharedView } from '@ui/contexts/SharedViewContext';
import DownloadReportButton from './contexts/header/DownloadReportButton';
import MoreMenu from './contexts/header/MoreMenu';
import { reportFor, offersMatrix } from './contexts/header/headerActions';
import AddInformation from './contexts/interviews/AddInformation';
import { useOrgKnowledge } from '@ui/hooks/useOrgKnowledge';

// ─── Header: the name, one sentence on what it is, and the page's actions ──
// The sentence ("Department · imported from Fortigi Demo HR") replaces the old
// row of classification badges; the raw values sit under More details for
// whoever can edit. Above the name, the parents as a breadcrumb. Below it
// (`children`), for a unit or an application, who answers for it.
//
// Actions: "Download report" (when the template has one — the reader's main
// action, for everyone), "Authorization workbench" (an analyst, on an
// organizational unit: onOpenWorkbench; the page offers it only while organisation
// knowledge is on; "3 proposed" on it when its saved investigations hold proposed
// roles: proposedCount), "Add information" (an analyst, on a unit or an
// application, while organisation knowledge is on), and a ⋯ menu with the rest (contexts/header/MoreMenu.jsx), each
// only when its handler is given:
//   onEdit        Edit (name, description, parent, template, delete)
//   onAddSubUnit  Add sub-unit
//   canAdjustTree Adjust tree (opens the tree's Adjust tree tab through onOpenDetail;
//                 only while organisation knowledge is on)
//   onOpenAsPage  Open as page (embedded in the Contexts page)
//   onClose       Back to Contexts (the page opened from the tree)
// View in matrix and Copy link are offered except in a read-only shell (a
// context owner's page), whose URL is not this unit's page and which cannot
// reach the matrix; there the breadcrumb names the direct parent only, without
// reading the parents the reader may not open. No owner chip: who answers for
// the context is the Accountable, shown below the name.

export default function ContextDetailHeader({ attrs, onClose, onOpenDetail, onOpenAsPage, onEdit, onAddSubUnit, canAdjustTree, addInformation = false, onOpenWorkbench, proposedCount = 0, children }) {
  const readOnly = useIsSharedView();
  const knowledge = useOrgKnowledge();
  const canEditRecipe = useCanBuildContexts() && isRecipeRoot(attrs) && !!onOpenDetail;
  const subtitle = contextSubtitle(attrs);
  const report = reportFor(attrs);

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Breadcrumb attrs={attrs} onOpenDetail={onOpenDetail} walk={!readOnly} />
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white break-words">{attrs.displayName || attrs.id}</h2>
          {subtitle && <p data-testid="context-subtitle" className="text-sm text-gray-600 dark:text-gray-400 mt-1">{subtitle}</p>}
          <ContextAccessCounts attrs={attrs} />
        </div>
        <div className="flex flex-wrap items-start gap-2">
          {report && <DownloadReportButton attrs={attrs} report={report.report} title={report.title} />}
          {onOpenWorkbench && (
            <button type="button" onClick={onOpenWorkbench} title="Group the people by what they do, see their access, and compose a candidate role"
              className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-800 hover:bg-emerald-100 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200 dark:hover:bg-emerald-900/50">
              Authorization workbench
              {proposedCount > 0 && ' '}
              {proposedCount > 0 && (
                <span className="ml-1rounded-full bg-emerald-200 px-1.5 py-0.5 text-xs font-semibold text-emerald-900 dark:bg-emerald-800 dark:text-emerald-100">{proposedCount} proposed</span>
              )}
            </button>
          )}
          {addInformation && knowledge && <AddInformation contextId={attrs.id} />}
          <MoreMenu
            attrs={attrs}
            matrix={offersMatrix(attrs, { sharedView: readOnly })}
            onAdjustTree={canAdjustTree && knowledge && onOpenDetail ? (treeKey, title) => onOpenDetail('adjust-tree', treeKey, title) : undefined}
            onEditRecipe={canEditRecipe ? () => onOpenDetail('context-builder', attrs.id, attrs.displayName) : undefined}
            onEdit={onEdit}
            onAddSubUnit={onAddSubUnit}
            copyLink={!readOnly}
            onOpenAsPage={onOpenAsPage}
            onClose={onClose}
          />
        </div>
      </div>
      {children}
    </div>
  );
}

// The parents above this context, root first, each opening its own page.
function Breadcrumb({ attrs, onOpenDetail, walk }) {
  const ancestors = useContextAncestors(attrs, { walk });
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
