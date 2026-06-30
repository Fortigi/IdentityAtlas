// Daily background update check. Mirrors the history-prune job: a short warm-up
// after startup (so it doesn't fight migrations) then once every 24h. The check
// is read-only — it only records what's available; applying is the external
// agent's job, gated on the AUTO_UPDATE_ENABLED flag.

import { runUpdateCheck } from './checkForUpdates.js';

export function startUpdateCheckJob() {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const FIRST_RUN_DELAY_MS = 90 * 1000;

  const run = () =>
    runUpdateCheck({ source: 'scheduler' }).catch((err) =>
      console.error('Daily update check failed (will retry tomorrow):', err.message)
    );

  setTimeout(run, FIRST_RUN_DELAY_MS);
  setInterval(run, DAY_MS);
}
