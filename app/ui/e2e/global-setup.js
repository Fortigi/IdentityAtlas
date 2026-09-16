// @ts-check
/**
 * Global setup for Playwright E2E tests.
 *
 * Runs once before all specs. Puts the deployment into the state the suite
 * assumes: every optional tab visible (Systems, Reports, Logs, Identities, Org
 * Chart, Risk Scores, Performance, Admin) via the preferences API, and the
 * opt-in feature flags the suite covers switched on, so no spec has to skip.
 *
 * Both are deliberately done HERE and not in a test: they are global server
 * state, so a test that flipped one would decide what every later test in the
 * run sees. Restoring the flags is global-teardown.js's job.
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

/**
 * Feature flags the suite needs switched on. `experimentalCrawlers` gates the
 * experimental crawler types out of the Add Crawler picker and makes
 * POST /admin/crawler-configs answer 403 for them, so their wizard specs can't
 * run at all while it is off. The OFF behaviour is asserted in isolation
 * instead — CrawlersPage.SelectType.test.jsx for the picker,
 * jobs.experimentalGate.test.js for the 403, and AC0 of the SCIM crawler's
 * Test-*Crawler.ps1 against a real API.
 */
export const REQUIRED_FEATURES = ['experimentalCrawlers'];

/** Where global-teardown.js reads the pre-run flag values back from. */
export const PRIOR_FEATURES_ENV = 'E2E_PRIOR_FEATURES';

export async function setVisibleTabs(tabs) {
  return fetch(`${BASE}/api/preferences`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visibleTabs: tabs }),
  });
}

export async function setFeature(feature, enabled) {
  return fetch(`${BASE}/api/admin/features/toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ feature, enabled }),
  });
}

/**
 * Switch on every flag in REQUIRED_FEATURES, returning the values they had
 * before so the teardown can put the deployment back as it found it. A flag
 * that is already on is left alone (and recorded as already on).
 */
export async function enableRequiredFeatures() {
  const prior = {};
  const res = await fetch(`${BASE}/api/features`);
  if (!res.ok) {
    console.warn(`Global setup: could not read feature flags (HTTP ${res.status}) — feature-gated specs may skip`);
    return prior;
  }
  const features = await res.json();
  for (const name of REQUIRED_FEATURES) {
    prior[name] = features[name] === true;
    if (prior[name]) continue;
    const toggled = await setFeature(name, true);
    if (!toggled.ok) {
      console.warn(`Global setup: could not enable "${name}" (HTTP ${toggled.status}) — its specs may skip`);
      delete prior[name];
    }
  }
  return prior;
}

async function globalSetup() {
  const res = await setVisibleTabs(ALL_OPTIONAL_TABS);

  if (res.ok) {
    console.log(`Global setup: enabled all optional tabs (${ALL_OPTIONAL_TABS.join(', ')})`);
  } else {
    console.warn(`Global setup: failed to enable tabs (HTTP ${res.status}) — optional tab tests may skip`);
  }

  const prior = await enableRequiredFeatures();
  // The teardown runs from its own module load, so hand the pre-run values over
  // through the environment rather than module state.
  process.env[PRIOR_FEATURES_ENV] = JSON.stringify(prior);
  const switchedOn = Object.keys(prior).filter(name => !prior[name]);
  if (switchedOn.length) console.log(`Global setup: switched on feature flag(s) ${switchedOn.join(', ')} for this run`);
}

export default globalSetup;
