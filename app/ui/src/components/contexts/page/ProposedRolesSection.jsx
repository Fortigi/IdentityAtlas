import { useState } from 'react';
import FoldSection from '@ui/components/contexts/FoldSection';
import { useIsDark } from '@ui/contexts/ThemeContext';
import { getAccessPackageColor } from '@ui/utils/colors';
import { proposalSummary, countsLine, dayOf } from './unitProposals';
import { useProposalRows } from './useUnitProposals';

// ─── Proposed roles — the unit's saved workbench proposals ───────────────
// Folded to "3 in 2 investigations"; opened, one row per proposed role saved in
// the unit's Authorization workbench investigations: its colour (as in the
// workbench's band), name, kind, the rule in one sentence (or "chosen by hand"),
// how many people it reaches now and how many entitlements, and where it is saved
// (investigation, who, when). A row opens the workbench on that investigation with
// that role in the panel (`onOpenRole(investigationId, proposalId)`). An analyst's
// section, like the workbench: hypotheses, nothing here is access.

function Row({ row, color, onOpenRole }) {
  return (
    <li>
      <button type="button" onClick={() => onOpenRole(row.investigationId, row.id)}
        className="flex w-full items-start gap-3 rounded px-2 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-gray-700/50">
        <span aria-hidden="true" className="mt-1 h-3 w-3 shrink-0 rounded-full border border-gray-300 dark:border-gray-600"
          style={{ backgroundColor: row.colorIdx === null ? 'transparent' : color(row.colorIdx) }} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-gray-900 dark:text-gray-100">
            <span className="font-medium">{row.name}</span>
            <span className="text-gray-600 dark:text-gray-400"> · {row.kind} · {countsLine(row)}</span>
          </span>
          <span className="block text-xs text-gray-700 dark:text-gray-300">{row.rule}</span>
          <span className="block text-xs text-gray-600 dark:text-gray-400">In “{row.investigationName}” · saved by {row.updatedBy}{dayOf(row.updatedAt) ? `, ${dayOf(row.updatedAt)}` : ''}</span>
        </span>
      </button>
    </li>
  );
}

export default function ProposedRolesSection({ id, contextId, list, onOpenRole }) {
  const [open, setOpen] = useState(false);
  const isDark = useIsDark();
  const { rows, error } = useProposalRows(contextId, list, open);
  if (!list || list.every(i => !(i.proposals?.length > 0))) return null;
  const color = (idx) => getAccessPackageColor(idx, isDark);
  return (
    <FoldSection id={id} title="Proposed roles" testId="proposed-roles" summary={proposalSummary(list)} open={open} onOpenChange={setOpen}>
      <p className="text-xs text-gray-600 dark:text-gray-400">Saved in the Authorization workbench — hypotheses, nothing here changes access. Open one to continue it there.</p>
      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
      {!rows && !error && <p className="text-sm text-gray-600 dark:text-gray-400">Loading…</p>}
      {rows && <ul className="-mx-2">{rows.map(r => <Row key={r.id} row={r} color={color} onOpenRole={onOpenRole} />)}</ul>}
    </FoldSection>
  );
}
