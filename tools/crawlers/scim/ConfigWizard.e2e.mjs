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

import { E2E_BASE as BASE, openCrawlerWizard } from '../shared/wizardE2EKit.mjs';

// What the stubbed POST /api/admin/crawlers/scim/discover answers with. Routing
// the discovery call in the browser keeps this test independent of any live SCIM
// service provider while still exercising the real wizard code that consumes it.
const DISCOVERY = {
  resourceTypes: [
    { id: 'User', name: 'User', endpoint: '/Users', schema: 'urn:ietf:params:scim:schemas:core:2.0:User', syncable: true },
    { id: 'Group', name: 'Group', endpoint: '/Groups', schema: 'urn:ietf:params:scim:schemas:core:2.0:Group', syncable: true },
    { id: 'Device', name: 'Device', endpoint: '/Devices', schema: 'urn:example:Device', syncable: false },
  ],
  // Group attributes come from a schema EXTENSION in every real endpoint — the core
  // Group schema is only displayName + members — and discovery advertises them as
  // bare names (issue #1209). 'type' is the attribute the bug was reported against.
  userAttributes: ['costCenter', 'department', 'preferredLanguage'],
  groupAttributes: ['description', 'type'],
  supportsFilter: true,
  supportsPatch: false,
};

export function register(test, expect) {
  // SCIM is an EXPERIMENTAL crawler, so it only appears in the Add Crawler picker
  // while the experimentalCrawlers flag is on. The CI stack sets
  // FEATURE_EXPERIMENTAL_CRAWLERS=true (docker-compose.ci.yml) rather than any test
  // toggling it: the flag is global server state, and a test that flipped it would
  // decide what every later test in the run sees. The OFF behaviour is asserted in
  // isolation instead — app/ui/src/components/CrawlersPage.SelectType.test.jsx for
  // the picker, app/api/src/routes/jobs.experimentalGate.test.js for the 403, and
  // AC0 in Test-ScimCrawler.ps1 against the real API.
  async function openScimWizard(page) {
    await page.route('**/api/admin/crawlers/scim/discover', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DISCOVERY) }));
    return openCrawlerWizard({
      page, test, expect, typeLabel: 'SCIM 2.0', heading: 'Add SCIM 2.0 Crawler',
    });
  }

  // Steps 1 and 2 are identical for every test that needs to get PAST them; only
  // the credential-gate test below cares about what they do on the way.
  async function fillConnectionAndCredentials(page, crawlerName) {
    await page.fill('input[placeholder="SCIM 2.0"]', crawlerName);
    await page.fill('input[placeholder="https://api.example.com/scim/v2"]', 'https://scim.example.com/scim/v2');
    await page.fill('input[placeholder="SAP CIS"]', crawlerName);
    await page.click('button:has-text("Next →")');

    await page.locator('label:has-text("Username") + input, label:has-text("Username") ~ input').first().fill('scim-user');
    await page.locator('input[type="password"]').first().fill('scim-pass');
    await page.click('button:has-text("Next →")');
  }

  test.describe('SCIM 2.0 crawler wizard', () => {

    test('SCIM 2.0 is offered as a crawler type, badged Experimental', async ({ page }) => {
      await page.goto(`${BASE}/#admin`);
      await page.waitForLoadState('networkidle');
      const addBtn = page.locator('button:has-text("Add Crawler")').first();
      if (!await addBtn.isVisible({ timeout: 5000 }).catch(() => false)) { test.skip(); return; }
      await addBtn.click();
      const scimBtn = page.locator('button:has-text("SCIM 2.0")').first();
      await expect(scimBtn).toBeEnabled();
      // The badge is what tells an operator this connector is not yet proven.
      await expect(scimBtn.locator('text=Experimental')).toBeVisible();
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
      await fillConnectionAndCredentials(page, crawlerName);

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

    // The reporter path from issue #1209: pick a GROUP attribute in the step-4
    // picker, save, and check it is still there. Every pickable group attribute
    // comes from a schema extension (the core Group schema is only displayName +
    // members), and the crawler used to drop exactly those on sync — so this walks
    // the same selection an operator makes and asserts it survives the round trip
    // through the API into the saved config the crawler then reads.
    test('a selected group attribute survives save and reopen (#1209)', async ({ page }) => {
      if (!await openScimWizard(page)) return;

      const crawlerName = `e2e-scim-group-attr-${Date.now()}`;
      await fillConnectionAndCredentials(page, crawlerName);

      // Step 3 — objects (defaults are fine; Groups is on).
      await expect(page.locator('text=Also served by this endpoint, but not syncable yet:')).toBeVisible({ timeout: 10000 });
      await page.click('button:has-text("Next →")');

      // Step 4 — the GROUP picker. Scoped to its own section: 'description' and
      // 'type' also have to be distinguishable from the user attributes above.
      const groupPicker = page.locator('div:has(> div > p:text-is("Group attributes"))');
      await expect(groupPicker).toBeVisible({ timeout: 10000 });
      const typeCheckbox = groupPicker.locator('label:has(span:text-is("type")) input[type="checkbox"]');
      await expect(typeCheckbox).not.toBeChecked();
      await typeCheckbox.check();
      // Only the one the operator ticked — 'description' stays out.
      await expect(groupPicker.locator('label:has(span:text-is("description")) input[type="checkbox"]')).not.toBeChecked();
      await expect(groupPicker.locator('text=1 selected')).toBeVisible();
      await page.click('button:has-text("Next →")');

      // Step 5 — mapping, then step 6 — review + save.
      await page.click('button:has-text("Next →")');
      await expect(page.locator('text=Extra attributes: 0 user, 1 group')).toBeVisible();
      await page.locator('button:has-text("Add Crawler")').last().click();

      // The saved card reports the group attribute…
      const card = page.locator('div')
        .filter({ has: page.locator(`h4:text-is("${crawlerName}")`) })
        .filter({ has: page.locator('button:has-text("Configure")') })
        .last();
      await expect(card).toBeVisible({ timeout: 15000 });
      await expect(page.locator('text=+1 group attr').first()).toBeVisible({ timeout: 15000 });

      // …and reopening the wizard reads the stored config back from the API, so a
      // selection that was dropped anywhere in that round trip shows up here.
      await card.locator('button:has-text("Configure")').first().click();
      await expect(page.locator('h3:has-text("Edit SCIM 2.0 Crawler")')).toBeVisible({ timeout: 10000 });
      for (let i = 0; i < 3; i++) await page.click('button:has-text("Next →")');
      const reopened = page.locator('div:has(> div > p:text-is("Group attributes"))');
      await expect(reopened.locator('label:has(span:text-is("type")) input[type="checkbox"]')).toBeChecked({ timeout: 10000 });
    });
  });
}
