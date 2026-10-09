// Organisation → Import wizard: start an import run and poll it to the end.
//
//   const { run, error, busy, start } = useImportRun();
//   await start({ sourceId, profileId, mode });   // POST /api/org-truth/runs (202 + run row)
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

  const poll = useCallback((id) => {
    stop();
    timer.current = setInterval(async () => {
      try {
        const next = await getJson(authFetch, `/runs/${encodeURIComponent(id)}`);
        setRun(next);
        if (isFinished(next)) { stop(); setBusy(false); }
      } catch { /* keep polling */ }
    }, POLL_MS);
  }, [authFetch]);

  const start = useCallback(async (body) => {
    setError(null);
    setBusy(true);
    try {
      const created = await sendJson(authFetch, '/runs', body);
      setRun(created);
      if (isFinished(created)) setBusy(false);
      else poll(created.id);
      return created;
    } catch (e) {
      setError(e.message);
      setBusy(false);
      return null;
    }
  }, [authFetch, poll]);

  return { run, error, busy, start };
}
