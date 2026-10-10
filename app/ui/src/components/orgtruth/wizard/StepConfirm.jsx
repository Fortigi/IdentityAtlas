// Import wizard step 7 — Confirm: the summary (wizardSummary.confirmRows), the profile (a name for a new
// one, "saves version N+1 of <name>" when a repeat changed anything, "uses
// <name> version N" otherwise), then Start import: POST or PUT /profiles, POST
// /runs { sourceId, profileId, mode }, and poll the run (useImportRun) until it
// completes or fails; the completed line is wizardSummary.runSummary (an
// activity run reads its key match counts). Close reports `imported` to the page so it refreshes.
import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useDialog } from '@ui/components/dialogContext';
import { WizardNav } from '@ui/components/crawler/wizardFields';
import { profileAction, profileBody, profileLine, qualityVerdict, stepReady } from './wizardDraft';
import { confirmRows, runSummary } from './wizardSummary';
import { sendJson } from './wizardApi';
import { useImportRun } from './useImportRun';
import { Field, Notice, START_IMPORT_CLS } from './wizardUi';

async function saveProfile(authFetch, draft) {
  const action = profileAction(draft);
  if (action === 'reuse') return draft.profile;
  if (action === 'version') return sendJson(authFetch, `/profiles/${encodeURIComponent(draft.profile.id)}`, profileBody(draft), 'PUT');
  return sendJson(authFetch, '/profiles', profileBody(draft));
}

function Summary({ draft }) {
  const { warnings } = qualityVerdict(draft.quality, draft.threshold);
  const rows = confirmRows(draft);
  return (
    <div className="space-y-2">
      <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-sm">
        {rows.map(([k, v]) => [
          <dt key={`${k}-t`} className="font-medium text-gray-700 dark:text-gray-300">{k}</dt>,
          <dd key={`${k}-d`} className="text-gray-900 dark:text-gray-100">{v}</dd>,
        ])}
      </dl>
      {warnings.map(w => <Notice key={w} variant="warning">{w}</Notice>)}
    </div>
  );
}

function RunProgress({ run }) {
  return (
    <div className="space-y-2" aria-live="polite">
      {run.status !== 'completed' && run.status !== 'failed' && (
        <p className="text-sm text-gray-800 dark:text-gray-200">Import {run.status ?? 'queued'}… {run.step ?? ''}{run.pct != null ? ` (${run.pct}%)` : ''}</p>
      )}
      {run.status === 'failed' && <Notice variant="error">The import failed: {run.error ?? 'unknown error'}</Notice>}
      {run.status === 'completed' && (
        <Notice variant="success">{runSummary(run.stats ?? {})}</Notice>
      )}
    </div>
  );
}

export default function StepConfirm({ draft, update, onBack, onError, onClose }) {
  const { authFetch } = useAuth();
  const dialog = useDialog();
  const { run, error, busy, start } = useImportRun();
  const [saving, setSaving] = useState(false);
  const action = profileAction(draft);
  const line = profileLine(draft);

  const startImport = async () => {
    onError(null);
    setSaving(true);
    try {
      const profile = await saveProfile(authFetch, draft);
      const created = await start({ sourceId: draft.source?.id, profileId: profile.id, mode: draft.runMode });
      if (created) dialog.toast('Import started', { variant: 'success' });
    } catch (e) {
      onError(`Could not save the import profile: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const finished = run?.status === 'completed' || run?.status === 'failed';
  return (
    <div className="space-y-4">
      <Summary draft={draft} />
      {action === 'create' && !run && (
        <Field label="Profile name" value={draft.profileName} onChange={v => update(d => ({ ...d, profileName: v }))}
          hint="The name you pick when you repeat this import later." />
      )}
      {line && <p className="text-sm text-gray-800 dark:text-gray-200">{line}</p>}
      {error && <Notice variant="error">{error}</Notice>}
      {run && <RunProgress run={run} />}

      {finished ? (
        <WizardNav onNext={() => onClose(run.status === 'completed')} nextLabel="Close" />
      ) : (
        <WizardNav onBack={run ? undefined : onBack} onNext={run ? undefined : startImport} nextLabel="Start import" nextCls={START_IMPORT_CLS}
          nextDisabled={saving || busy || !stepReady(7, draft)} />
      )}
    </div>
  );
}
