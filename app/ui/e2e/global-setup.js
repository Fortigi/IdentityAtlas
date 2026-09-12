// @ts-check
/**
 * Global setup for Playwright E2E tests.
 *
 * Runs once before all specs. Enables all optional tabs (Systems, Reports,
 * Logs, Identities, Org Chart, Risk Scores, Performance, Admin) via the
 * preferences API so every spec can navigate to every page without skipping.
 */

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3001';

/**
 * Every optional (opt-in) tab key. A spec that changes tab preferences to test
 * the opt-in itself restores this list afterwards, so the rest of the suite
 * keeps seeing every tab.
 */
export const ALL_OPTIONAL_TABS = [
  'systems', 'reports', 'sync-log', 'risk-scores', 'identities', 'org-chart', 'performance', 'admin',
];

export async function setVisibleTabs(tabs) {
  return fetch(`${BASE}/api/preferences`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visibleTabs: tabs }),
  });
}

async function globalSetup() {
  const res = await setVisibleTabs(ALL_OPTIONAL_TABS);

  if (res.ok) {
    console.log(`Global setup: enabled all optional tabs (${ALL_OPTIONAL_TABS.join(', ')})`);
  } else {
    console.warn(`Global setup: failed to enable tabs (HTTP ${res.status}) — optional tab tests may skip`);
  }
}

export default globalSetup;
