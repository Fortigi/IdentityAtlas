import { lazy, useState } from 'react';
import { useProposedLens } from './useProposedLens';
import { investigationLabel } from './proposedLens';

const MatrixView = lazy(() => import('@ui/components/MatrixView'));

// ─── The matrix's "Proposed" lens ────────────────────────────────────────
// The saved proposed roles of the workbench's investigations, as the matrix shows
// business roles: each a band "Draft: <name>" in its own colour, the cells it
// covers in that colour, a member who lacks one of its entitlements as the
// matrix's provisioning gap — over the matrix rows of the accounts it reaches (and
// everything else they hold). The real business roles keep their bands and
// colours, so an overlap shows. "From investigation" picks one, or all.

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
  const { list, lens, loading, error } = useProposedLens(investigationId || null, accessPackageGroups);
  const empty = list !== null && list.length === 0;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 rounded border border-amber-200 bg-amber-50 px-3 py-1.5 dark:border-amber-800 dark:bg-amber-900/20" role="region" aria-label="Proposed roles">
        <span className="text-xs font-medium text-amber-900 dark:text-amber-100">Proposed roles from saved workbench investigations — hypotheses, nothing here changes access</span>
        {list && list.length > 0 && <Picker list={list} value={investigationId} onChange={setInvestigationId} />}
        {loading && <span className="text-xs text-gray-600 dark:text-gray-400">Loading…</span>}
      </div>
      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
      {empty && <p className="text-sm text-gray-700 dark:text-gray-300">No workbench investigation with a proposed role is saved yet.</p>}
      {lens && !empty && (
        <MatrixView {...props} data={lens.data} accessPackageGroups={lens.accessPackageGroups} managedByPackages={lens.managedByPackages} showProposed />
      )}
    </div>
  );
}
