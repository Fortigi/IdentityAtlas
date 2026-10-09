// Organisation → Model (workstream T6).
//
// The meta-graph from GET /api/org-truth/model: entity types with their counts,
// predicates between them, and the links from entity types to the system types
// (Principal, Identity, Resource, Context). Always drawable whole: it is dozens
// of nodes, never the instances.
//
// Two views behind a toggle — Diagram (ModelDiagram, hand-laid-out SVG) and
// Table (the same data, sortable by count) — plus filters per source
// (`?sourceId=`, options from GET /sources) and "include closed"
// (`?includeClosed=1`), a totals line, and the model as Mermaid text with a
// Copy button. Below the overview the link-rule editor (LinkRulesEditor):
// one canvas per import profile to correct, add and remove links after the fact.
//
// Props: { onImport }
import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useCanImportOrgTruth } from '@ui/hooks/useCanImportOrgTruth';
import EmptyState from '@ui/components/EmptyState';
import CopyButton from '@ui/components/CopyButton';
import { formatDate } from '@ui/utils/formatters';
import { buildQuery, fetchBlocked, rowsOf } from './orgFormat';
import { mermaidText, sortByCount } from './modelGraph';
import ModelDiagram from './ModelDiagram';
import LinkRulesEditor from './LinkRulesEditor';
import { FetchState, TH, TD, CARD, INPUT } from './orgUi';

const VIEWS = [{ key: 'diagram', label: 'Diagram' }, { key: 'table', label: 'Table' }];

function CountHeader({ dir, onToggle }) {
  return (
    <th scope="col" className={TH} aria-sort={dir === 'asc' ? 'ascending' : 'descending'}>
      <button type="button" onClick={onToggle} className="hover:underline">
        Count {dir === 'asc' ? '▲' : '▼'}
      </button>
    </th>
  );
}

function ModelTable({ model }) {
  const [typeDir, setTypeDir] = useState('desc');
  const [predDir, setPredDir] = useState('desc');
  const flip = (d) => (d === 'asc' ? 'desc' : 'asc');
  return (
    <div className="space-y-4">
      <div className={`${CARD} overflow-x-auto`}>
        <table className="w-full text-sm" aria-label="Entity types">
          <thead className="bg-gray-50 dark:bg-gray-700/50">
            <tr>
              <th scope="col" className={TH}>Type</th>
              <CountHeader dir={typeDir} onToggle={() => setTypeDir(flip)} />
              <th scope="col" className={TH}>Proposed</th>
              <th scope="col" className={TH}>Attribute keys</th>
              <th scope="col" className={TH}>Sources</th>
              <th scope="col" className={TH}>Last observed</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {sortByCount(model.entityTypes, typeDir).map(t => (
              <tr key={t.type}>
                <td className={`${TD} font-medium`}>{t.type}</td>
                <td className={TD}>{t.count}</td>
                <td className={TD}>{t.proposed ?? 0}</td>
                <td className={TD}>{(t.attributeKeys || []).join(', ')}</td>
                <td className={TD}>{t.sources ?? ''}</td>
                <td className={TD}>{formatDate(t.lastObservedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={`${CARD} overflow-x-auto`}>
        <table className="w-full text-sm" aria-label="Predicates">
          <thead className="bg-gray-50 dark:bg-gray-700/50">
            <tr>
              <th scope="col" className={TH}>Predicate</th>
              <th scope="col" className={TH}>From</th>
              <th scope="col" className={TH}>To</th>
              <CountHeader dir={predDir} onToggle={() => setPredDir(flip)} />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {sortByCount(model.predicates, predDir).map(p => (
              <tr key={`${p.fromType}:${p.predicate}:${p.toType}`}>
                <td className={`${TD} font-medium`}>{p.predicate}</td>
                <td className={TD}>{p.fromType}</td>
                <td className={TD}>{p.toType}</td>
                <td className={TD}>{p.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Totals({ totals }) {
  if (!totals) return null;
  return (
    <p className="text-sm text-gray-600 dark:text-gray-400" data-testid="model-totals">
      {totals.entities ?? 0} entities · {totals.relations ?? 0} relations · {totals.links ?? 0} links · {totals.sources ?? 0} sources
    </p>
  );
}

function ViewToggle({ view, onChange }) {
  return (
    <div className="inline-flex rounded border border-gray-300 dark:border-gray-600 overflow-hidden" role="group" aria-label="View">
      {VIEWS.map(v => (
        <button
          key={v.key}
          type="button"
          aria-pressed={view === v.key}
          onClick={() => onChange(v.key)}
          className={`px-3 py-1 text-sm ${view === v.key
            ? 'bg-blue-600 text-white dark:bg-blue-700'
            : 'bg-white text-gray-700 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'}`}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}

export default function ModelTab({ onImport }) {
  const { authFetch } = useAuth();
  const canImport = useCanImportOrgTruth();
  const [view, setView] = useState('diagram');
  const [sourceId, setSourceId] = useState('');
  const [includeClosed, setIncludeClosed] = useState(false);
  const sources = useFetch('/api/org-truth/sources', { authFetch });
  const state = useFetch(`/api/org-truth/model${buildQuery({ sourceId, includeClosed })}`, { authFetch });
  const model = state.data;
  const sourceRows = rowsOf(sources.data);

  const filters = (
    <div className="flex flex-wrap items-center gap-4">
      {sourceRows.length > 0 && (
        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          Source
          <select className={INPUT} value={sourceId} onChange={e => setSourceId(e.target.value)}>
            <option value="">All sources</option>
            {sourceRows.map(s => <option key={s.id} value={s.id}>{s.displayName}</option>)}
          </select>
        </label>
      )}
      <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        <input type="checkbox" checked={includeClosed} onChange={e => setIncludeClosed(e.target.checked)} />
        Include closed
      </label>
      <div className="ml-auto flex items-center gap-2">
        <ViewToggle view={view} onChange={setView} />
        {model && <CopyButton text={mermaidText(model)} label="Copy as Mermaid" title="Copy the model as Mermaid text" />}
      </div>
    </div>
  );

  if (fetchBlocked(state)) {
    return <div className="space-y-4">{filters}<FetchState state={state} what="Model" /></div>;
  }
  if ((model?.entityTypes || []).length === 0) {
    return (
      <div className="space-y-4">
        {filters}
        <EmptyState
          title="No model yet"
          hint="The model is read from the imported lists. Import a list to see its entity types and how they relate."
          actionLabel={canImport ? 'Import organisation truth' : undefined}
          onAction={onImport}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {filters}
      <Totals totals={model.totals} />
      {view === 'diagram'
        ? <div className={`${CARD} p-3`}><ModelDiagram model={model} /></div>
        : <ModelTable model={model} />}
      <LinkRulesEditor model={model} onRelinked={state.reload} />
    </div>
  );
}
