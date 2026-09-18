// One request at a time, with its busy flag and its error message — the shape both
// assistant conversations need (the report builder's useAskConversation, the context
// builder's useTermConversation).
//
// Kept here rather than in either of them: they are the same three lines of bookkeeping
// around a different request, and duplicating it is exactly what the duplication gate
// (Reuse before creating) exists to stop.

import { useState } from 'react';

/**
 * @returns {{ busy: boolean, error: string|null, setError: Function, run: (work: Function) => Promise<void> }}
 *   run() marks the work busy, clears the previous error, and shows this one's message.
 */
export function useBusyRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const run = async (work) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return { busy, error, setError, run };
}
