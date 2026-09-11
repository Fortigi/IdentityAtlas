// @ts-check
/**
 * SCIM 2.0 crawler wizard — end-to-end interaction test.
 *
 * tools/crawlers/scim/ConfigWizard.test.jsx only renders step 1 via
 * renderToStaticMarkup, which executes no event handlers, so the six-step flow —
 * the credential gate, the opt-in attribute picker against a REAL discovery
 * response, the userType mapping rows, and the save round trip that creates a
 * CrawlerConfigs row and renders the Summary card — had no automated coverage.
 * This drives the real wizard in a browser against the real backend, with a
 * stubbed SCIM service provider so discovery returns deterministic data.
 *
 * Named *.e2e.mjs and exporting register(test, expect) rather than importing
 * { test, expect } from '@playwright/test': @playwright/test is only installed
 * under app/ui/node_modules and tools/crawlers/ isn't a descendant of app/ui, so
 * this file can't resolve it. app/ui/e2e/crawler-plugin-tests.spec.js is the one
 * loader that imports it, discovers every tools/crawlers/<type>/*.e2e.mjs and
 * calls register() on it. See tools/crawlers/csv/ConfigWizard.e2e.mjs for the
 * full explanation.
 */

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3001';

// What the stubbed POST /api/admin/crawlers/scim/discover answers with. Routing
// the discovery call in the browser keeps this test independent of any live SCIM
// service provider while still exercising the real wizard code that consumes it.
const DISCOVERY = {
  resourceTypes: [
    { id: 'User', name: 'User', endpoint: '/Users', schema: 'urn:ietf:params:scim:schemas:core:2.0:User', syncable: true },
    { id: 'Group', name: 'Group', endpoint: '/Groups', schema: 'urn:ietf:params:scim:schemas:core:2.0:Group', syncable: true },
    { id: 'Device', name: 'Device', endpoint: '/Devices', schema: 'urn:example:Device', syncable: false },
  ],
  userAttributes: ['costCenter', 'department', 'preferredLanguage'],
  groupAttributes: ['description'],
  supportsFilter: true,
  supportsPatch: false,
};

export function register(test, expect) {
  // SCIM ships as an EXPERIMENTAL crawler, so it is absent from the Add Crawler
  // picker until Admin → Experimental → Experimental crawlers is on. Every test
  // below drives the picker, so each one switches the flag on first (the endpoint
  // is idempotent). The last test in the file turns it off on purpose to prove the
  // picker hides SCIM, and restores it in a finally.
  async function setExperimentalCrawlers(page, enabled) {
    const res = await page.request.post(`${BASE}/api/admin/features/toggle`, {
      data: { feature: 'experimentalCrawlers', enabled },
    });
    return res.ok();
  }

  async function openScimWizard(page) {
    await page.route('**/api/admin/crawlers/scim/discover', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DISCOVERY) }));

    await setExperimentalCrawlers(page, true);
    await page.goto(`${BASE}/#admin`);
    await page.waitForLoadState('networkidle');
    // .first() — an empty-data install shows a second "Add Crawler" CTA in the
    // welcome banner alongside the toolbar button; both open the same picker.
    const addBtn = page.locator('button:has-text("Add Crawler")').first();
    if (!await addBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      test.skip();
      return false;
    }
    await addBtn.click();
    const scimBtn = page.locator('button:has-text("SCIM 2.0")').first();
    await expect(scimBtn).toBeVisible({ timeout: 5000 });
    await scimBtn.click();
    await expect(page.locator('h3:has-text("Add SCIM 2.0 Crawler")')).toBeVisible({ timeout: 10000 });
    return true;
  }

  test.describe('SCIM 2.0 crawler wizard', () => {

    test('SCIM 2.0 is offered as a crawler type once experimental crawlers are on', async ({ page }) => {
      await setExperimentalCrawlers(page, true);
      await page.goto(`${BASE}/#admin`);
      await page.waitForLoadState('networkidle');
      const addBtn = page.locator('button:has-text("Add Crawler")').first();
      if (!await addBtn.isVisible({ timeout: 5000 }).catch(() => false)) { test.skip(); return; }
      await addBtn.click();
      const scimBtn = page.locator('button:has-text("SCIM 2.0")').first();
      await expect(scimBtn).toBeVisible();
      await expect(scimBtn).toBeEnabled();
    });

    test('credentials gate the wizard until the auth method is satisfied', async ({ page }) => {
      if (!await openScimWizard(page)) return;

      // Step 1 — Next stays disabled until a base URL is entered.
      const next = page.locator('button:has-text("Next →")');
      await page.fill('input[placeholder="https://api.example.com/scim/v2"]', '');
      await expect(next).toBeDisabled();
      await page.fill('input[placeholder="https://api.example.com/scim/v2"]', 'https://scim.example.com/scim/v2');
      await expect(next).toBeEnabled();
      await next.click();

      // Step 2 — BasicAuth needs BOTH username and password.
      await expect(page.locator('text=Auth method:')).toBeVisible();
      await expect(page.locator('button:has-text("Next →")')).toBeDisabled();
      await page.fill('input[type="password"]', 'pw');
      await expect(page.locator('button:has-text("Next →")')).toBeDisabled();
      await page.locator('label:has-text("Username") + input, label:has-text("Username") ~ input').first().fill('scim-user');
      await expect(page.locator('button:has-text("Next →")')).toBeEnabled();
    });

    test('walks the six steps and saves a config the summary card reflects', async ({ page }) => {
      if (!await openScimWizard(page)) return;

      const crawlerName = `e2e-scim-${Date.now()}`;
      await page.fill('input[placeholder="SCIM 2.0"]', crawlerName);
      await page.fill('input[placeholder="https://api.example.com/scim/v2"]', 'https://scim.example.com/scim/v2');
      await page.fill('input[placeholder="SAP CIS"]', crawlerName);
      await page.click('button:has-text("Next →")');

      // Step 2 — credentials.
      await page.locator('label:has-text("Username") + input, label:has-text("Username") ~ input').first().fill('scim-user');
      await page.locator('input[type="password"]').first().fill('scim-pass');
      await page.click('button:has-text("Next →")');

      // Step 3 — objects. Discovery ran; a non-syncable resource type is shown
      // as visible-but-not-yet rather than offered as a toggle.
      const notSyncable = page.locator('div:has(> p:text-is("Also served by this endpoint, but not syncable yet:"))');
      await expect(notSyncable).toBeVisible({ timeout: 10000 });
      await expect(notSyncable.locator('span', { hasText: 'Device' }).first()).toBeVisible();
      await page.fill('input[type="number"]', '25');
      await page.click('button:has-text("Next →")');

      // Step 4 — the attribute picker is OPT-IN: nothing is selected on arrival.
      await expect(page.locator('text=User attributes')).toBeVisible({ timeout: 10000 });
      const deptCheckbox = page.locator('label:has-text("department") input[type="checkbox"]').first();
      await expect(deptCheckbox).not.toBeChecked();
      await deptCheckbox.check();
      await expect(page.locator('text=1 selected').first()).toBeVisible();

      // Select all picks up every discovered user attribute.
      await page.locator('button:has-text("Select all")').first().click();
      await expect(page.locator('text=3 selected').first()).toBeVisible();
      await page.click('button:has-text("Next →")');

      // Step 5 — userType → principalType mapping.
      await expect(page.locator('text=User type → principal type')).toBeVisible();
      await page.click('button:has-text("Next →")');

      // Step 6 — save without a schedule.
      await expect(page.locator('text=No schedules configured.')).toBeVisible();
      await expect(page.locator('text=Extra attributes: 3 user, 0 group')).toBeVisible();
      // .last() — the admin toolbar's own "Add Crawler" button is still in the DOM
      // behind the wizard; the save button is the one inside the wizard card.
      await page.locator('button:has-text("Add Crawler")').last().click();

      // The card list now shows this crawler with its SCIM summary panel.
      const card = page.locator(`text=${crawlerName}`).first();
      await expect(card).toBeVisible({ timeout: 15000 });
      await expect(page.locator('text=https://scim.example.com/scim/v2').first()).toBeVisible();
      await expect(page.locator('text=+3 user attrs').first()).toBeVisible();
    });
  });

  // Turning the flag off must remove SCIM from the picker WITHOUT touching a SCIM
  // crawler that is already configured. Serial, and the flag is restored in a
  // finally, so a failure here cannot leave the feature off for a later run.
  test.describe.serial('experimental crawlers switched off', () => {
    test('hides SCIM from the Add Crawler picker but leaves a configured one in place', async ({ page }) => {
      await setExperimentalCrawlers(page, true);
      await page.goto(`${BASE}/#admin`);
      await page.waitForLoadState('networkidle');
      const addBtn = page.locator('button:has-text("Add Crawler")').first();
      if (!await addBtn.isVisible({ timeout: 5000 }).catch(() => false)) { test.skip(); return; }

      // Whatever SCIM crawlers this install already has must survive the switch.
      const configured = await page.request.get(`${BASE}/api/admin/crawler-configs`);
      const before = configured.ok()
        ? (await configured.json()).filter(c => c.crawlerType === 'scim').length
        : 0;

      try {
        await setExperimentalCrawlers(page, false);
        await page.goto(`${BASE}/#admin`);
        await page.waitForLoadState('networkidle');
        await page.locator('button:has-text("Add Crawler")').first().click();
        await expect(page.locator('h3:has-text("Add Crawler — Select Type")')).toBeVisible();
        // A stable type is still offered — the picker is filtered, not emptied.
        await expect(page.locator('button:has-text("Microsoft Graph")').first()).toBeVisible();
        await expect(page.locator('button:has-text("SCIM 2.0")')).toHaveCount(0);

        const after = await page.request.get(`${BASE}/api/admin/crawler-configs`);
        const stillThere = (await after.json()).filter(c => c.crawlerType === 'scim').length;
        expect(stillThere).toBe(before);
      } finally {
        await setExperimentalCrawlers(page, true);
      }
    });
  });
}
