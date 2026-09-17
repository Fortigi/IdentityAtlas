// PROTOTYPE — the report builder's working definition and its preview run.
//
// Owns the definition being edited, whether it has changed since the last run, and
// the outcome of that run: the result, a failure, or a "did you mean" question.

import { useCallback, useState } from 'react';
import { postJson } from './AskAssistant.api';

export function useReportPreview(authFetch) {
  const [spec, setSpec] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState(null);
  const [confirm, setConfirm] = useState(null);

  // Stable, so the saved-report preview fires once per definition rather than on
  // every render.
  const run = useCallback(async (s) => {
    setRunning(true);
    setRunError(null);
    setConfirm(null);
    try {
      const r = await postJson(authFetch, '/api/nl-reports/run', { spec: s });
      setResult(r);
      setSpec(r.spec);
      setDirty(false);
    } catch (e) {
      // A name that did not match exactly: let the analyst say which object they meant.
      if (e.body?.confirm) setConfirm({ spec: e.body.spec, confirm: e.body.confirm });
      else setRunError(e.message);
    } finally {
      setRunning(false);
    }
  }, [authFetch]);

  const confirmChoice = async (choice) => {
    setRunning(true);
    try {
      const resolved = await postJson(authFetch, '/api/nl-reports/resolve', { spec: confirm.spec, choice });
      setSpec(resolved.spec);
      if (resolved.confirm) setConfirm({ spec: resolved.spec, confirm: resolved.confirm });
      else { setConfirm(null); await run(resolved.spec); }
    } catch (e) {
      setRunError(e.message);
    } finally {
      setRunning(false);
    }
  };

  // A hand edit: the preview no longer shows this definition.
  const editSpec = (s) => { setSpec(s); setDirty(true); };

  return { spec, setSpec, editSpec, dirty, result, running, runError, confirm, run, confirmChoice };
}
