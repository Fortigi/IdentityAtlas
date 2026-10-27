import { useEffect, useMemo, useState } from 'react';
import { useWorkbenchData, useWorkbenchDraft } from './useWorkbench';
import { groupPeople, indexCells, accessCounts, cellsByResource as byResource, startsCrowded } from './workbench.model';
import { knowledgeGaps, knownNames } from './workbench.labels';
import WorkbenchGrid from './WorkbenchGrid';
import CandidatePanel from './CandidatePanel';
import { Toolbar, SelectionBar, Legend } from './WorkbenchControls';

// ─── Authorization workbench ─────────────────────────────────────────────
// Opens from an organizational unit (#workbench:<unit id>): its people and what
// they hold, seen through what is known of their work — the activities they
// perform, their expertise, the duties they hold beside it (claims, with their
// source and status). The analyst groups and sorts by those, selects clusters of
// access, marks what belongs elsewhere, and composes a candidate role while the
// impact shows in the grid. A hypothesis workspace: nothing is saved and nothing
// changes access. Design: docs/architecture/m1-discovery-and-design.md.

// minHolders null: automatic — 2 when the unit holds many things (startsCrowded), else 1.
const DEFAULT_VIEW = { groupBy: 'activity', sortBy: 'name', includeChildren: true, overlay: false, minHolders: null, columnSearch: '' };

function visibleColumns(columns, view) {
  const q = view.columnSearch.trim().toLowerCase();
  return columns.filter(c => c.holders >= view.minHolders && (!q || c.displayName.toLowerCase().includes(q) || (c.systemName || '').toLowerCase().includes(q)));
}

export default function WorkbenchPage({ contextId, onCacheData, onClose }) {
  const [view, setView] = useState(DEFAULT_VIEW);
  const { data, loading, error, reload, send } = useWorkbenchData(contextId, view.includeChildren);
  const [draft, dispatch] = useWorkbenchDraft();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const unitName = data?.unit?.displayName;

  useEffect(() => {
    if (unitName) onCacheData?.(contextId, 'workbench', { displayName: `Workbench: ${unitName}` });
  }, [unitName, contextId, onCacheData]);

  // A unit whose people hold many things opens on what at least two of them share.
  const shownView = useMemo(() => (data && view.minHolders === null ? { ...view, minHolders: startsCrowded(data) ? 2 : 1 } : view), [data, view]);
  const derived = useMemo(() => derive(data, shownView), [data, shownView]);

  if (!data) return <PageStatus loading={loading} error={error} onRetry={reload} />;

  const act = async (fn) => {
    setBusy(true); setActionError(null);
    try { await fn(); await reload(); } catch (err) { setActionError(err.message); } finally { setBusy(false); }
  };
  const personProps = {
    busy, knownNames: derived.knownNames,
    onDecide: (claimId, status) => act(() => send(`/api/contexts/claims/${claimId}`, 'PATCH', { status })),
    onAdd: (person, kind, value) => act(() => send(`/api/contexts/${contextId}/knowledge`, 'POST',
      { kind, value, ...(person.identityId ? { identityId: person.identityId } : { principalId: person.principalId }) })),
  };

  return (
    <div className="space-y-3">
      <Header data={data} gaps={derived.gaps} shownColumns={derived.columns.length} onClose={onClose} loading={loading} />
      <Toolbar view={shownView} setView={setView} />
      {actionError && <p role="alert" className="rounded border border-red-200 bg-red-50 px-3 py-1.5 text-sm text-red-700 dark:border-red-700 dark:bg-red-900/30 dark:text-red-300">{actionError}</p>}
      <SelectionBar selection={draft.selection} dispatch={dispatch} cellIndex={derived.cellIndex} />
      <div className="flex flex-col gap-3 xl:flex-row xl:items-start">
        <div className="min-w-0 flex-1 space-y-2">
          <WorkbenchGrid groups={derived.groups} columns={derived.columns} cellIndex={derived.cellIndex} draft={draft} dispatch={dispatch}
            overlay={view.overlay} personProps={personProps} />
          <Legend overlay={view.overlay} />
        </div>
        <div className="w-full shrink-0 xl:w-96">
          <CandidatePanel draft={draft} dispatch={dispatch} data={data} cellIndex={derived.cellIndex} cellsByResource={derived.cellsByResource}
            peopleByKey={derived.peopleByKey} columnsById={derived.columnsById} />
        </div>
      </div>
    </div>
  );
}

function derive(data, view) {
  if (!data) return null;
  const cellIndex = indexCells(data.cells);
  const counts = accessCounts(data.cells);
  return {
    cellIndex,
    cellsByResource: byResource(data.cells),
    groups: groupPeople(data.people, view.groupBy, view.sortBy, (k) => counts.get(k) ?? 0),
    columns: visibleColumns(data.columns, view),
    peopleByKey: new Map(data.people.map(p => [p.key, p])),
    columnsById: new Map(data.columns.map(c => [c.id, c])),
    gaps: knowledgeGaps(data.people),
    knownNames: knownNames(data.people),
  };
}

function Header({ data, gaps, shownColumns, onClose, loading }) {
  const { unit, scope, people, columns, truncatedColumns } = data;
  const accounts = people.reduce((n, p) => n + p.accounts.length, 0);
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Authorization workbench</p>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">{unit.displayName}</h2>
          <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
            {people.length} people ({accounts} accounts){scope.includeChildren && scope.units > 1 ? ` across ${scope.units} units` : ''} ·
            {' '}{shownColumns} of {columns.length + truncatedColumns} things they hold shown · access as read {new Date(data.generatedAt).toLocaleString()}
            {loading ? ' · refreshing…' : ''}
          </p>
          <p className="mt-0.5 text-sm text-gray-700 dark:text-gray-300">
            {gaps.noActivity} {gaps.noActivity === 1 ? 'person has' : 'people have'} no known activity · {gaps.proposed} proposed {gaps.proposed === 1 ? 'link' : 'links'} to check · {gaps.disputed} disputed
          </p>
          {scope.unresolved > 0 && (
            <p role="status" className="mt-0.5 text-xs text-amber-800 dark:text-amber-200">
              {scope.unresolved} {scope.unresolved === 1 ? 'member is' : 'members are'} no longer in their source (a later sync removed them) and {scope.unresolved === 1 ? 'is' : 'are'} left out.
            </p>
          )}
          {(scope.truncatedPeople || truncatedColumns > 0) && (
            <p className="mt-0.5 text-xs text-amber-800 dark:text-amber-200">
              {scope.truncatedPeople ? `Only the first ${scope.maxPeople} people are shown. ` : ''}
              {truncatedColumns > 0 ? `${truncatedColumns} rarely held columns are left out.` : ''}
            </p>
          )}
        </div>
        <div className="flex items-start gap-2">
          <span className="rounded bg-amber-100 px-2 py-1 text-xs text-amber-900 dark:bg-amber-900/40 dark:text-amber-100" title="Candidate roles live in this browser tab only">
            Hypotheses only — nothing here changes access
          </span>
          {onClose && <button type="button" onClick={onClose} className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700">Close</button>}
        </div>
      </div>
    </div>
  );
}

function PageStatus({ loading, error, onRetry }) {
  if (loading && !error) return <p className="p-8 text-sm text-gray-600 dark:text-gray-400">Loading the workbench…</p>;
  return (
    <div role="alert" className="mx-auto mt-12 max-w-md rounded-lg border border-red-200 bg-red-50 p-6 dark:border-red-700 dark:bg-red-900/30">
      <h2 className="text-lg font-semibold text-red-800 dark:text-red-300">Could not load the workbench</h2>
      <p className="mt-2 text-sm text-red-700 dark:text-red-300">{error}</p>
      <button type="button" onClick={onRetry} className="mt-3 text-sm text-blue-700 underline dark:text-blue-300">Try again</button>
    </div>
  );
}
