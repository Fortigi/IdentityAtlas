// Start an extraction, follow it, cancel it, and list earlier runs.
//
//   POST /knowledge/sources/:id/extract { mode }  → 202 run, or 409 { error, setup? }
//   GET  /knowledge/runs/:id                       polled every 1.5 s (useImportRun)
//   POST /knowledge/runs/:id/cancel                stops after the current model call
//
// A run already active when the page opens (runs[0]) is followed too.
//
// Props: { sourceId, runs, canEdit, onFinished() }
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useDialog } from '@ui/components/dialogContext';
import { API, sendJson } from '@ui/components/orgtruth/wizard/wizardApi';
import { useImportRun } from '@ui/components/orgtruth/wizard/useImportRun';
import { CARD, SMALL_BUTTON, InlineError } from '@ui/components/orgtruth/orgUi';
import { KNOWLEDGE, isRunActive } from './knowledgeFormat';
import { RunProgress, RunHistory } from './RunViews';

async function postExtract(authFetch, sourceId, mode) {
  const res = await authFetch(`${API}${KNOWLEDGE}/sources/${encodeURIComponent(sourceId)}/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { error: { message: body.error || `HTTP ${res.status}`, setup: body.setup || '' } };
  return { run: body };
}

function StartControls({ busy, onStart }) {
  const [single, setSingle] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" disabled={busy} onClick={() => onStart(single ? 'single' : 'pipeline')}
        className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-700 dark:hover:bg-blue-600">
        Extract
      </button>
      <label className="flex items-center gap-1 text-xs text-gray-700 dark:text-gray-300">
        <input type="checkbox" checked={single} onChange={e => setSingle(e.target.checked)} />
        Baseline: single prompt
      </label>
    </div>
  );
}

export default function RunPanel({ sourceId, runs, canEdit, onFinished }) {
  const { authFetch } = useAuth();
  const dialog = useDialog();
  const { run, busy, track } = useImportRun({ base: KNOWLEDGE });
  const [startError, setStartError] = useState(null);
  const [starting, setStarting] = useState(false);
  const followed = useRef(null);
  const latest = runs[0] ?? null;
  const shown = run ?? (isRunActive(latest) ? latest : null);

  // Follow a run that was already going when the transcript opened.
  useEffect(() => {
    if (run || !isRunActive(latest) || followed.current === latest.id) return;
    followed.current = latest.id;
    track(latest, onFinished);
  }, [run, latest, track, onFinished]);

  async function start(mode) {
    setStartError(null);
    setStarting(true);
    try {
      const out = await postExtract(authFetch, sourceId, mode);
      if (out.error) setStartError(out.error);
      else track(out.run, onFinished);
    } catch (err) {
      setStartError({ message: err.message, setup: '' });
    }
    setStarting(false);
  }

  async function cancel() {
    try {
      await sendJson(authFetch, `${KNOWLEDGE}/runs/${encodeURIComponent(shown.id)}/cancel`, {});
      dialog.toast('Cancel requested — the run stops after the current model call.', { variant: 'info' });
    } catch (err) {
      dialog.alert(`The run was not cancelled: ${err.message}`);
    }
  }

  return (
    <div className={`${CARD} space-y-3 p-4`}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">Extraction</h3>
        {canEdit && !isRunActive(shown) && <StartControls busy={busy || starting} onStart={start} />}
      </div>
      {startError && <InlineError message={[startError.message, startError.setup].filter(Boolean).join(' ')} />}
      {shown && <RunProgress run={shown} canCancel={canEdit} onCancel={cancel} />}
      <details>
        <summary className={`${SMALL_BUTTON} inline-block cursor-pointer`}>Run history ({runs.length})</summary>
        <div className="mt-2"><RunHistory runs={runs} /></div>
      </details>
    </div>
  );
}
