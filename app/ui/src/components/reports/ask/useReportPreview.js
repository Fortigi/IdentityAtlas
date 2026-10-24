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
  // `logId` is the conversation-store row /interpret wrote for this definition;
  // /run fills in what it returned. `conversationId` is the chat it belongs to,
  // so the next question there can say "these groups". The builder runs edited
  // definitions with no row and no chat behind them and passes nothing.
  const run = useCallback(async (s, logId, conversationId) => {
    setRunning(true);
    setRunError(null);
    setConfirm(null);
    try {
      const body = { spec: s, ...(logId ? { logId } : {}), ...(conversationId ? { conversationId } : {}) };
      const r = await postJson(authFetch, '/api/nl-reports/run', body);
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

  // Back to nothing: no definition, no result, no pending choice. What the Ask
  // tab does when a conversation starts over or another one is opened — a
  // result left on screen from the previous chat would read as this one's.
  const reset = () => { setSpec(null); setDirty(false); setResult(null); setRunError(null); setConfirm(null); };

  return { spec, setSpec, editSpec, dirty, result, running, runError, confirm, run, confirmChoice, reset };
}
