// @ts-check
/**
 * The crawler card tells the operator which system this crawler registers (#1240).
 *
 * Reported symptom, step by step: a crawler the operator called "SAP CIS Test"
 * showed `System: SCIM` in its card Summary on Admin → Crawlers, and running it
 * registered a system called "SCIM" — so several SCIM connectors were
 * indistinguishable on the Systems page and in every `__system` filter, and
 * renaming the crawler renamed nothing.
 *
 * The cause was a stored `systemName: "SCIM"` — the type literal, which the
 * pre-#1207 wizard baked in whenever the optional System name field was left
 * blank. It is indistinguishable from a deliberate override, so it shadowed the
 * crawler's own name on every run forever. A stored override that is an exact
 * copy of the type default now counts as not set, in the run
 * (tools/crawlers/shared/Get-CrawlerSystemName.ps1) and on the card
 * (Summary.jsx) alike.
 *
 * This walks the browser half of that path — the card an operator actually reads
 * before pressing Run — against a real backend. The run's half needs a live SCIM
 * endpoint and is asserted by Test-ScimCrawler.ps1 (AC10/AC11) against the mock
 * server instead; no run is queued here.
 *
 * Named *.e2e.mjs and exporting register(test, expect) rather than importing
 * { test, expect } — see ConfigWizard.e2e.mjs in this folder for why.
 */

import { E2E_API, E2E_BASE, deleteCrawlerConfigs, enableFeatureFlag } from '../shared/wizardE2EKit.mjs';

const CONFIG_PREFIX = 'e2e-scim-naming-';

/** The bare type literal the pre-#1207 wizard stored, and the old card showed. */
const TYPE_LITERAL = 'SCIM';

const BASE_CONFIG = {
  baseUrl: 'https://e2e.example.com/scim',
  authMethod: 'BasicAuth',
  username: 'e2e',
  password: 'e2e-placeholder',
  pageSize: 100,
};

async function createConfig(displayName, extra) {
  const res = await fetch(`${E2E_API}/admin/crawler-configs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ crawlerType: 'scim', displayName, config: { ...BASE_CONFIG, ...extra } }),
  });
  if (!res.ok) throw new Error(`could not create the crawler config: ${res.status} ${await res.text()}`);
  return (await res.json()).id;
}

export function register(test, expect) {
  test.describe('SCIM crawler card — which system it says it registers', () => {
    /** @type {(() => Promise<void>)|null} */
    let restoreFlag = null;

    test.beforeAll(async () => {
      // SCIM is experimental: with the flag off, POST /admin/crawler-configs
      // answers 403 and no card exists to look at.
      restoreFlag = await enableFeatureFlag('experimentalCrawlers');
    });

    test.afterAll(async () => {
      await deleteCrawlerConfigs(name => name.startsWith(CONFIG_PREFIX));
      if (restoreFlag) await restoreFlag();
    });

    /** The card of one crawler, and the "System:" line inside it. */
    async function systemLineFor(page, displayName) {
      await page.goto(`${E2E_BASE}/#admin`);
      // A second goto to the same URL only changes the hash, which leaves the
      // already-mounted app (and its fetched config list) exactly as it was —
      // so a card renamed via the API would never appear. Reload explicitly.
      await page.reload();
      await page.waitForLoadState('networkidle');
      const card = page.locator('div.rounded-lg')
        .filter({ has: page.getByRole('heading', { level: 4, name: displayName, exact: true }) })
        .first();
      await expect(card).toBeVisible({ timeout: 15000 });
      return card.locator('div').filter({ hasText: /^System:/ }).first();
    }

    test('a config with the type literal baked in shows the crawler name, not "SCIM" (#1240)', async ({ page }) => {
      const name = `${CONFIG_PREFIX}stale-${Date.now()}`;
      // Exactly what a crawler saved before #1207 carries in its stored config.
      const configId = await createConfig(name, { systemName: TYPE_LITERAL });
      try {
        // Before the fix this line read "System: SCIM" — the crawler type — and
        // the run agreed with it, which is what made several SCIM connectors
        // indistinguishable everywhere the system name is shown.
        await expect(await systemLineFor(page, name)).toHaveText(`System: ${name}`);

        // Renaming the crawler moves the system name with it.
        const renamed = `${name}-renamed`;
        const patched = await fetch(`${E2E_API}/admin/crawler-configs/${configId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayName: renamed }),
        });
        expect(patched.ok, await patched.text()).toBeTruthy();
        await expect(await systemLineFor(page, renamed)).toHaveText(`System: ${renamed}`);
      } finally {
        await fetch(`${E2E_API}/admin/crawler-configs/${configId}`, { method: 'DELETE' }).catch(() => null);
      }
    });

    test('an explicitly set system name still wins over the crawler name', async ({ page }) => {
      const name = `${CONFIG_PREFIX}override-${Date.now()}`;
      const override = `${name}-system`;
      const configId = await createConfig(name, { systemName: override });
      try {
        await expect(await systemLineFor(page, name)).toHaveText(`System: ${override}`);
      } finally {
        await fetch(`${E2E_API}/admin/crawler-configs/${configId}`, { method: 'DELETE' }).catch(() => null);
      }
    });

    test('an override that merely contains the type literal is kept', async ({ page }) => {
      // Only the bare literal is the pre-#1207 leftover; "SCIM Test" is a name
      // somebody chose and discarding it would silently rename their system.
      const name = `${CONFIG_PREFIX}contains-${Date.now()}`;
      const configId = await createConfig(name, { systemName: `${TYPE_LITERAL} Test` });
      try {
        await expect(await systemLineFor(page, name)).toHaveText(`System: ${TYPE_LITERAL} Test`);
      } finally {
        await fetch(`${E2E_API}/admin/crawler-configs/${configId}`, { method: 'DELETE' }).catch(() => null);
      }
    });
  });
}
