// Organisation → Model → the model canvas: one import profile under the
// canvas. Its name, version and last run, "Unsaved changes" while the canvas
// holds edits to its rules, "Save and link again" (POST /profiles/:id/relink
// with the profile's whole rule list, then the run is polled with
// useImportRun.track and the model reloads), the 400 reasons, and the plain
// list of its rules with Edit/Remove (the keyboard-and-screen-reader path to
// every line on the canvas). Readers see the list without controls.
//
// Props: { profile, rules, dirty, canEdit, onEdit(index), onRemove(index),
//          onBusy(busy), onSaved() }
import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useImportRun } from './wizard/useImportRun';
import { ruleLabel, signalsSummary, relinkProfile } from './linkRulesDraft';
import { SMALL_BUTTON, StatusPill } from './orgUi';

const SAVE_CLS = 'px-3 py-1.5 text-sm rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed dark:bg-green-700 dark:hover:bg-green-600';

function RunProgress({ run }) {
  if (!run) return null;
  const links = run.stats?.links ?? {};
  let text = `Linking again… ${run.step ?? run.status ?? 'queued'}${run.pct != null ? ` (${run.pct}%)` : ''}`;
  if (run.status === 'completed') text = `Linked again${links.linked != null ? `: ${links.linked} linked, ${links.proposed ?? 0} proposed for review` : ''}.`;
  if (run.status === 'failed') text = `Linking again failed: ${run.error ?? 'unknown error'}`;
  return <p role="status" aria-live="polite" className="text-sm text-gray-700 dark:text-gray-300">{text}</p>;
}

export function SaveErrors({ error }) {
  if (!error) return null;
  return (
    <div role="alert" className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-700 dark:bg-red-900/30 dark:text-red-300">
      <p>{error.message}</p>
      {error.list.length > 0 && <ul className="mt-1 list-disc pl-5">{error.list.map(e => <li key={e}>{e}</li>)}</ul>}
    </div>
  );
}

function RuleList({ name, rules, canEdit, onEdit, onRemove }) {
  if (rules.length === 0) return <p className="text-sm text-gray-600 dark:text-gray-400">No link rules yet.</p>;
  return (
    <ul aria-label={`Link rules of ${name}`} className="divide-y divide-gray-100 dark:divide-gray-700 text-sm">
      {rules.map((r, i) => {
        const label = ruleLabel(r);
        return (
          <li key={`${label}:${i}`} className="flex flex-wrap items-center gap-3 py-1.5 text-gray-700 dark:text-gray-300">
            <span className="font-medium text-gray-900 dark:text-gray-100">{label}</span>
            <span>{signalsSummary(r.signals)}</span>
            <span>threshold {r.threshold ?? 50}</span>
            {canEdit && (
              <span className="ml-auto flex gap-2">
                <button type="button" className={SMALL_BUTTON} aria-label={`Edit ${label}`} onClick={() => onEdit(i)}>Edit</button>
                <button type="button" className={SMALL_BUTTON} aria-label={`Remove ${label}`} onClick={() => onRemove(i)}>Remove</button>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export default function ProfileRules({ profile, rules, dirty, canEdit, onEdit, onRemove, onBusy, onSaved }) {
  const { authFetch } = useAuth();
  const { run, busy, track } = useImportRun();
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setError(null);
    setSaving(true);
    onBusy(true);
    const res = await relinkProfile(authFetch, profile.id, rules);
    setSaving(false);
    if (!res.ok) { onBusy(false); setError({ message: res.error, list: res.errors }); return; }
    track(res.run, () => { onBusy(false); onSaved(); });
  };

  return (
    <div className="space-y-2 py-3" data-profile={profile.name}>
      <div className="flex flex-wrap items-center gap-3">
        <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{profile.name}</h4>
        <span className="text-xs text-gray-600 dark:text-gray-400">version {profile.version}</span>
        <StatusPill status={profile.lastRunStatus} />
        {dirty && <span className="text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">Unsaved changes</span>}
        {canEdit && (
          <button type="button" className={`${SAVE_CLS} ml-auto`} aria-label={`Save and link again: ${profile.name}`}
            disabled={!dirty || busy || saving} onClick={save}>
            Save and link again
          </button>
        )}
      </div>
      <SaveErrors error={error} />
      <RunProgress run={run} />
      <RuleList name={profile.name} rules={rules} canEdit={canEdit && !busy && !saving} onEdit={onEdit} onRemove={onRemove} />
    </div>
  );
}
