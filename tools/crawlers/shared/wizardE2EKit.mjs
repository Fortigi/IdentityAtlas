// @ts-check
/**
 * Shared Playwright steps for the crawler wizard e2e tests.
 *
 * Every tools/crawlers/<type>/ConfigWizard.e2e.mjs opened its wizard the same
 * way — go to #admin, find the Add Crawler button, skip if the page isn't
 * there, click the crawler's tile, wait for the wizard heading — so the block
 * existed once per crawler.
 *
 * Deliberately NOT named *.e2e.mjs: app/ui/e2e/crawler-plugin-tests.spec.js
 * discovers files by that suffix and calls register() on them, and this module
 * exports helpers rather than tests.
 */

export const E2E_BASE = process.env.E2E_BASE_URL || 'http://localhost:3001';
export const E2E_API = `${E2E_BASE}/api`;

/**
 * Turn a feature flag on for the duration of one spec file, returning the
 * function that puts it back.
 *
 * An experimental crawler is invisible in the Add Crawler picker and refused by
 * POST /admin/crawler-configs unless its flag is on, so a spec for one cannot
 * just hope the deployment happens to have it enabled — it has to say so. The
 * flag is a stored WorkerConfig override that BEATS the container's env var, so
 * "the CI stack sets FEATURE_EXPERIMENTAL_CRAWLERS=true" is not enough either:
 * anything that ran earlier and wrote the override wins, and the whole spec then
 * fails at "crawler type not found in the picker".
 *
 * Restoring matters for the same reason in the other direction — leaving the
 * override behind would decide what every later run against this deployment
 * sees.
 *
 * @param {string} name  a flag name as returned by GET /api/features
 * @returns {Promise<() => Promise<void>>} restore function (a no-op if the flag
 *   was already on, or if the deployment doesn't expose feature toggles)
 */
export async function enableFeatureFlag(name) {
  const noop = async () => {};
  const before = await fetch(`${E2E_API}/features`)
    .then(r => (r.ok ? r.json() : null))
    .catch(() => null);
  if (!before || before[name] === true) return noop;

  const set = async (enabled) => fetch(`${E2E_API}/admin/features/toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ feature: name, enabled }),
  }).catch(() => null);

  const res = await set(true);
  if (!res || !res.ok) return noop;
  return async () => { await set(before[name] === true); };
}

/**
 * Delete every crawler config whose displayName the predicate accepts.
 *
 * A wizard spec that saves a config leaves a real row behind, so without this
 * the Configured Crawlers grid grows by one card per run — and specs that reach
 * for `.last()` or count cards get less deterministic the longer a deployment
 * has been tested against. Failures are swallowed: cleanup must never be the
 * thing that fails a run.
 *
 * @param {(displayName: string) => boolean} matches
 */
export async function deleteCrawlerConfigs(matches) {
  const configs = await fetch(`${E2E_API}/admin/crawler-configs`)
    .then(r => (r.ok ? r.json() : []))
    .catch(() => []);
  for (const cfg of Array.isArray(configs) ? configs : []) {
    if (!matches(String(cfg?.displayName || ''))) continue;
    await fetch(`${E2E_API}/admin/crawler-configs/${cfg.id}`, { method: 'DELETE' }).catch(() => null);
  }
}

/**
 * Open the Add Crawler picker and start one crawler's wizard.
 *
 * Returns false (having called test.skip()) when the admin page isn't
 * available — a stack without the Crawlers tab is a skip, not a failure.
 *
 * @param {object} args
 * @param {import('@playwright/test').Page} args.page
 * @param {any} args.test      the `test` object, for test.skip()
 * @param {any} args.expect    the `expect` function
 * @param {string} args.typeLabel  the tile's visible name, e.g. 'SCIM 2.0'
 * @param {string} args.heading    the wizard heading, e.g. 'Add SCIM 2.0 Crawler'
 */
export async function openCrawlerWizard({ page, test, expect, typeLabel, heading }) {
  await page.goto(`${E2E_BASE}/#admin`);
  await page.waitForLoadState('networkidle');
  // .first() — an empty-data install shows a second "Add Crawler" CTA in the
  // welcome banner alongside the toolbar button; both open the same picker.
  const addBtn = page.locator('button:has-text("Add Crawler")').first();
  if (!await addBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    test.skip();
    return false;
  }
  await addBtn.click();
  const tile = page.locator(`button:has-text("${typeLabel}")`).first();
  await expect(tile).toBeVisible({ timeout: 5000 });
  await tile.click();
  await expect(page.locator(`h3:has-text("${heading}")`)).toBeVisible({ timeout: 10000 });
  return true;
}
