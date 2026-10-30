import { lazy, useMemo, useState } from 'react';
import { useProposedLens } from './useProposedLens';
import { investigationLabel, lensPackages, withProposalCoverage } from './proposedLens';

const MatrixView = lazy(() => import('@ui/components/MatrixView'));

// ─── The matrix with "+ Proposed roles" on ───────────────────────────────
// The view the analyst has — whichever lens, All / Governed / Non-governed / Gaps,
// exactly as without the toggle — plus the proposed roles saved in workbench
// investigations on top: each a band "Draft: <name>" in its own colour, the cells
// it would cover in that colour, a member who lacks one of its entitlements as the
// matrix's provisioning gap. The real business roles keep their bands and colours,
// so an overlap shows; the lens filters still read only the real coverage.
// "From investigation" picks one, or all. Session-only: never saved with a matrix
// or a share link (app/MatrixArea). Nothing here changes access.

function Picker({ list, value, onChange }) {
  return (
    <label className="flex flex-wrap items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
      From investigation
      <select value={value} onChange={e => onChange(e.target.value)} aria-label="From investigation"
        className="rounded border border-gray-300 bg-white px-1 py-0.5 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100">
        <option value="">All ({list.length})</option>
        {list.map(i => <option key={i.id} value={i.id}>{investigationLabel(i)}</option>)}
      </select>
    </label>
  );
}

export default function ProposedMatrix({ accessPackageGroups, ...props }) {
  const [investigationId, setInvestigationId] = useState('');
  const { list, proposals, loading, error } = useProposedLens(investigationId || null);
  // The overlay: the proposals as role bands next to the real ones, and only their cells to colour.
  const overlay = useMemo(() => ({
    accessPackageGroups: [...(accessPackageGroups || []), ...lensPackages(proposals || [])],
    extraCoverage: withProposalCoverage([], proposals || []),
  }), [accessPackageGroups, proposals]);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 rounded border border-amber-200 bg-amber-50 px-3 py-1.5 dark:border-amber-800 dark:bg-amber-900/20" role="region" aria-label="Proposed roles">
        <span className="text-xs font-medium text-amber-900 dark:text-amber-100">Proposed roles from saved workbench investigations, on top of this view — hypotheses, nothing here changes access</span>
        {list && list.length > 0 && <Picker list={list} value={investigationId} onChange={setInvestigationId} />}
        {list && list.length === 0 && <span className="text-xs text-gray-700 dark:text-gray-300">No workbench investigation with a proposed role is saved yet.</span>}
        {loading && <span className="text-xs text-gray-600 dark:text-gray-400">Loading…</span>}
        {error && <span role="alert" className="text-xs text-red-700 dark:text-red-300">{error}</span>}
      </div>
      <MatrixView {...props} accessPackageGroups={overlay.accessPackageGroups} extraCoverage={overlay.extraCoverage} showProposed proposedOn />
    </div>
  );
}
