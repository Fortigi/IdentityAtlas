// PROTOTYPE — create or edit a custom report, in its own tab (#report-builder:<id>).
//
// id "new-…" starts an empty report; any other id is a saved report being edited.
// A report can be built two ways, freely mixed: describe it to the local model
// (AskAssistant), or build/adjust the definition by hand (SpecEditor). The
// preview always shows what will actually run. Saving stores the definition;
// saved reports appear in the Reports list and open in the normal report tab.

import { useEffect, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useDialog } from '@ui/components/dialogContext';
import { useCanBuildReports } from '@ui/hooks/useCanBuildReports';
import ReportError from '@ui/components/reports/ReportError';
import AskAssistant from './AskAssistant';
import { useReportPreview } from './useReportPreview';
import { useSavedReportActions } from './useSavedReportActions';
import { CARD, H3, BuilderHeader, ReportDetailsForm, DefinitionPanel, PreviewResults } from './ReportBuilderParts';

function blankSpec(catalog, entity = 'user') {
  return { entity, match: 'all', conditions: [], columns: [...catalog.entities[entity].defaultColumns] };
}

// Why the builder cannot be shown yet (or at all), or null once it can.
function builderBlocker({ enabled, catalog, spec, error, onClose }) {
  if (!enabled) {
    return (
      <ReportError
        title="You cannot build reports here"
        message="Custom reports are either switched off for this install (Admin → Experimental) or your role does not include Build custom reports."
        onClose={onClose}
      />
    );
  }
  if (error) {
    return <ReportError title="Cannot open the report builder" message={error.message} onClose={onClose} />;
  }
  if (!catalog || !spec) {
    return <div className="flex h-64 items-center justify-center text-gray-500 dark:text-gray-400">Loading…</div>;
  }
  return null;
}

export default function ReportBuilderPage({ builderId, onClose, onOpenDetail, onCacheData }) {
  const { authFetch } = useAuth();
  const dialog = useDialog();
  const enabled = useCanBuildReports();
  const isNew = builderId.startsWith('new-');

  const { data: catalog, error: catalogError } = useFetch('/api/nl-reports/catalog', { authFetch });
  const { data: saved, error: savedError } = useFetch(isNew ? null : `/api/nl-reports/saved/${encodeURIComponent(builderId)}`, { authFetch, enabled: !isNew });

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [question, setQuestion] = useState('');
  const [seeded, setSeeded] = useState(null);
  const preview = useReportPreview(authFetch);
  const { spec, setSpec, result, run } = preview;
  const actions = useSavedReportActions({
    authFetch, dialog, builderId, isNew, draft: { name, description, question, spec }, onOpenDetail, onClose, onCacheData,
  });

  // Seed the form once from the saved report (render-time, not in an effect).
  if (saved && saved !== seeded) {
    setSeeded(saved);
    setName(saved.name);
    setDescription(saved.description || '');
    setQuestion(saved.question || '');
    setSpec(saved.definition);
  }
  // Start a new report with an editable, empty definition.
  if (isNew && catalog && !spec && seeded !== 'blank') {
    setSeeded('blank');
    setSpec(blankSpec(catalog));
  }

  const tabLabel = saved?.name;
  useEffect(() => {
    if (tabLabel) onCacheData?.(builderId, 'report-builder', { displayName: tabLabel });
  }, [tabLabel, builderId, onCacheData]);

  // Preview a saved report as soon as it is loaded. The run is kicked off after the
  // effect returns rather than inside it: starting it inline sets the "running" flag
  // during the same commit, which cascades a render before the tab has painted once.
  const savedDefinition = saved?.definition;
  useEffect(() => {
    if (!savedDefinition) return undefined;
    const id = setTimeout(() => run(savedDefinition), 0);
    return () => clearTimeout(id);
  }, [savedDefinition, run]);

  const onReport = (reply, asked) => {
    setSpec(reply.spec);
    if (!question) setQuestion(asked);
    if (!name) setName(asked.length > 80 ? `${asked.slice(0, 77)}…` : asked);
    run(reply.spec);
  };

  const blocker = builderBlocker({ enabled, catalog, spec, error: catalogError || savedError, onClose });
  if (blocker) return blocker;

  return (
    <section className="mx-auto max-w-6xl space-y-4" aria-labelledby="builder-heading">
      <BuilderHeader
        isNew={isNew} name={name} message={actions.message} saving={actions.saving}
        onOpenReport={() => onOpenDetail?.('report', `custom-${builderId}`, name)}
        onDelete={actions.remove} onSave={actions.save}
      />
      <ReportDetailsForm name={name} description={description} onNameChange={setName} onDescriptionChange={setDescription} />

      <div className={CARD}>
        <h3 className={H3}>Describe it <span className="font-normal text-gray-600 dark:text-gray-400">— optional, uses the local model</span></h3>
        <AskAssistant currentSpec={isNew && !result ? null : spec} onReport={onReport} />
      </div>

      <DefinitionPanel
        spec={spec} catalog={catalog} dirty={preview.dirty} result={result} running={preview.running}
        onEdit={preview.editSpec} onRun={() => run(spec)}
      />
      <PreviewResults
        name={name} confirm={preview.confirm} running={preview.running} runError={preview.runError} result={result}
        onChoose={preview.confirmChoice} onOpenDetail={onOpenDetail}
      />
    </section>
  );
}
