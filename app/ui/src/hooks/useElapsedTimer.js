import { useState, useEffect } from 'react';

// Elapsed-seconds counter for a long-running action. While `active` is true it
// ticks every 500ms so the UI can show "12s elapsed"; when `active` flips back
// to false the counter resets to 0 (reset happens during render on the
// transition so the effect body holds no synchronous setState —
// react-hooks/set-state-in-effect).
export function useElapsedTimer(active) {
  const [elapsedMs, setElapsedMs] = useState(0);
  const [wasActive, setWasActive] = useState(active);
  if (active !== wasActive) {
    setWasActive(active);
    if (!active) setElapsedMs(0);
  }
  useEffect(() => {
    if (!active) return undefined;
    const start = Date.now();
    const interval = setInterval(() => setElapsedMs(Date.now() - start), 500);
    return () => clearInterval(interval);
  }, [active]);
  return Math.floor(elapsedMs / 1000);
}
