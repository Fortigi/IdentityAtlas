// Loads the model and pre-reads the prompt when the builder opens, so the first
// question doesn't pay for it.

import { useEffect, useRef, useState } from 'react';
import { postJson } from './AskAssistant.api';

// The states in which the model is still on its way in.
const LOADING_STATES = new Set(['warming', 'starting', 'preparing']);

export function isWarmLoading(warm) {
  return LOADING_STATES.has(warm);
}

/**
 * @param {object}   [status]   the /api/nl-reports/status answer
 * @param {Function} authFetch
 * @returns {'idle'|'ready'|'warming'|'starting'|'preparing'|'error'}
 */
export function useModelWarmup(status, authFetch) {
  const [warm, setWarm] = useState('idle');
  const warmed = useRef(false);

  useEffect(() => {
    if (!status?.available || warmed.current) return;
    warmed.current = true;
    setWarm(status.loaded && status.promptCache === 'ready' ? 'ready' : 'warming');
    // Two waits, told apart by the server: loading the model into memory ('starting',
    // seconds — it is unloaded after a while unused) and the one-off prompt-cache
    // preparation after an install or update ('preparing', minutes). Poll until done;
    // quickly while loading, so the page flips to ready as soon as the model is in.
    const poll = () => postJson(authFetch, '/api/nl-reports/warm', {})
      .then((r) => {
        if (r.state === 'starting' || r.state === 'preparing') {
          setWarm(r.state);
          setTimeout(poll, r.state === 'starting' ? 2000 : 10000);
          return;
        }
        setWarm('ready');
      })
      .catch(() => setWarm('error'));
    poll();
  }, [status, authFetch]);

  return warm;
}

export function useElapsed(active) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const started = Date.now();
    const id = setInterval(() => setSeconds(Math.round((Date.now() - started) / 1000)), 500);
    return () => { clearInterval(id); setSeconds(0); };
  }, [active]);
  return seconds;
}
