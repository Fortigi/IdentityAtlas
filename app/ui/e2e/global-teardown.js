// @ts-check
/**
 * Global teardown for Playwright E2E tests.
 *
 * Puts back the feature flags global-setup.js switched on for the run. Without
 * this, running the suite against a deployment would leave opt-in features
 * silently enabled on it — the same reason the SCIM crawler's
 * Test-ScimCrawler.ps1 restores the flag it toggles.
 *
 * Tab preferences are deliberately NOT restored: they are a display preference
 * the suite normalises, not a feature the operator opted into.
 */

import { PRIOR_FEATURES_ENV, setFeature } from './global-setup.js';

async function globalTeardown() {
  let prior = {};
  try {
    prior = JSON.parse(process.env[PRIOR_FEATURES_ENV] || '{}');
  } catch {
    return; // Setup never recorded anything — nothing to restore.
  }
  for (const [name, wasEnabled] of Object.entries(prior)) {
    if (wasEnabled) continue; // It was already on; leave it on.
    const res = await setFeature(name, false);
    if (!res.ok) console.warn(`Global teardown: could not switch "${name}" back off (HTTP ${res.status})`);
  }
}

export default globalTeardown;
