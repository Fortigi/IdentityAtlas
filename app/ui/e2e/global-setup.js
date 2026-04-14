// @ts-check
/**
 * Global setup for Playwright E2E tests.
 *
 * Runs once before all specs. Enables all optional tabs (Identities,
 * Org Chart, Risk Scores, Performance, Admin) via the preferences API
 * so every spec can navigate to every page without skipping.
 */

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3001';

async function globalSetup() {
  const allTabs = ['risk-scores', 'identities', 'org-chart', 'performance', 'admin'];

  const res = await fetch(`${BASE}/api/preferences`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visibleTabs: allTabs }),
  });

  if (res.ok) {
    console.log(`Global setup: enabled all optional tabs (${allTabs.join(', ')})`);
  } else {
    console.warn(`Global setup: failed to enable tabs (HTTP ${res.status}) — optional tab tests may skip`);
  }
}

export default globalSetup;
