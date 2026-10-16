// Organisation → Import wizard: start an import run and poll it to the end.
//
//   const { run, error, busy, start } = useImportRun();
//   await start({ sourceId, profileId, mode });   // POST /api/org-truth/runs (202 + run row)
//   track(run, onFinish);                          // poll a run another call created (relink)
//
// Then GET /api/org-truth/runs/:id every 1.5 s until status is `completed` or
// `failed` (the AccountLinkingSettings poller, as a hook). A failed poll request
// keeps polling; a 501 or any error from the start call lands in `error`.
// The interval is started from the event handler, never from an effect, and is
// cleared on unmount.
import { useState, useRef, useEffect, useCallback } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { getJson, sendJson } from './wizardApi';

export const POLL_MS = 1500;
export const isFinished = (run) => run?.status === 'completed' || run?.status === 'failed';

export function useImportRun() {
  const { authFetch } = useAuth();
  const [run, setRun] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);

  const stop = () => { clearInterval(timer.current); timer.current = null; };
  useEffect(() => stop, []);

  const poll = useCallback((id, onFinish) => {
    stop();
    timer.current = setInterval(async () => {
      try {
        const next = await getJson(authFetch, `/runs/${encodeURIComponent(id)}`);
        setRun(next);
        if (isFinished(next)) { stop(); setBusy(false); onFinish?.(next); }
      } catch { /* keep polling */ }
    }, POLL_MS);
  }, [authFetch]);

  // Show and poll a run that is already created; onFinish(run) runs once when
  // it completes or fails (from the poll, never from an effect).
  const track = useCallback((created, onFinish) => {
    setError(null);
    setRun(created);
    if (isFinished(created)) { setBusy(false); onFinish?.(created); }
    else { setBusy(true); poll(created.id, onFinish); }
  }, [poll]);

  const start = useCallback(async (body) => {
    setError(null);
    setBusy(true);
    try {
      const created = await sendJson(authFetch, '/runs', body);
      track(created);
      return created;
    } catch (e) {
      setError(e.message);
      setBusy(false);
      return null;
    }
  }, [authFetch, track]);

  return { run, error, busy, start, track };
}
