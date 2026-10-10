// Organisation → Model.
//
// The model canvas (LinkRulesEditor) is the whole tab: every list's entity types
// and the system types (Principal, Identity, Resource, Context) on ONE draggable
// canvas, where links are corrected, added and removed after the fact. The
// meta-graph comes from GET /api/org-truth/model; above the canvas sit an
// "include closed" filter (`?includeClosed=1`), a totals line, and the model as
// Mermaid text with a Copy button. (A separate overview diagram and table used
// to sit above the canvas; the canvas made them redundant.)
//
// Props: { onImport }
import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useCanImportOrgTruth } from '@ui/hooks/useCanImportOrgTruth';
import EmptyState from '@ui/components/EmptyState';
import CopyButton from '@ui/components/CopyButton';
import { buildQuery, fetchBlocked } from './orgFormat';
import { mermaidText } from './modelGraph';
import LinkRulesEditor from './LinkRulesEditor';
import { FetchState } from './orgUi';

function Totals({ totals }) {
  if (!totals) return null;
  return (
    <p className="text-sm text-gray-600 dark:text-gray-400" data-testid="model-totals">
      {totals.entities ?? 0} entities · {totals.relations ?? 0} relations · {totals.links ?? 0} links · {totals.sources ?? 0} sources
    </p>
  );
}

export default function ModelTab({ onImport }) {
  const { authFetch } = useAuth();
  const canImport = useCanImportOrgTruth();
  const [includeClosed, setIncludeClosed] = useState(false);
  const state = useFetch(`/api/org-truth/model${buildQuery({ includeClosed })}`, { authFetch });
  const model = state.data;

  const filters = (
    <div className="flex flex-wrap items-center gap-4">
      <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        <input type="checkbox" checked={includeClosed} onChange={e => setIncludeClosed(e.target.checked)} />
        Include closed
      </label>
      <div className="ml-auto flex items-center gap-2">
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
          actionLabel={canImport ? 'Import additional information' : undefined}
          onAction={onImport}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {filters}
      <Totals totals={model.totals} />
      <LinkRulesEditor model={model} onRelinked={state.reload} />
    </div>
  );
}
