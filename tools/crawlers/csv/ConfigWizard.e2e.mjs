// @ts-check
/**
 * CSV crawler wizard — step 2 (file upload/list/delete) interaction tests.
 *
 * tools/crawlers/csv/ConfigWizard.test.jsx only renders step 1 via
 * renderToStaticMarkup, which executes no event handlers — so staging files,
 * the required-object coverage panel, and the real upload/list/delete round
 * trip against app/api/src/routes/crawlerFiles.js had no automated coverage.
 * This drives the real wizard in a browser against the real backend.
 *
 * Named *.e2e.mjs, not *.spec.js, and exports register(test, expect)
 * instead of importing { test, expect } from '@playwright/test' directly —
 * a file here has no ancestor node_modules containing @playwright/test
 * (it's only installed under app/ui/node_modules, and tools/crawlers/
 * isn't a descendant of app/ui), the same root cause as the Docker
 * frontend-build's node_modules-hoisting fix (see app/api/Dockerfile).
 * app/ui/e2e/crawler-plugin-tests.spec.js discovers and loads every
 * tools/crawlers/<type>/*.e2e.mjs file and calls register() on it, so the
 * @playwright/test import only ever happens from inside app/ui. The .mjs
 * extension forces ESM unambiguously — Playwright's loader doesn't apply
 * Node's "detect module syntax" auto-detection that a plain .js file here
 * would need (no ancestor package.json declares "type": "module").
 */

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3001';

// Header row per fixture — must satisfy the wizard's upload-time header
// validation (csv-slots.json `requiredColumns`). Most slots key on
// ExternalId/DisplayName; Assignments keys on Resource/User external ids.
const FIXTURE_HEADERS = {
  'Assignments.csv': 'ResourceExternalId;UserExternalId',
};
function csvFile(name) {
  const header = FIXTURE_HEADERS[name] || 'ExternalId;DisplayName';
  return { name, mimeType: 'text/csv', buffer: Buffer.from(`${header}\n`) };
}

// A non-schema export, as it comes out of the source: foreign column names,
// filenames that match no slot, mixed delimiters, and one multi-value cell.
// Nothing here loads without a mapping, which is the point.
const MAPPED_FIXTURES = {
  'ad_people.csv': 'samaccountname,cn,mail,physicalDeliveryOfficeName\nu1,Alice,alice@x.test,Utrecht\n',
  'ad_groups.csv': 'group_dn;group_name\nCN=Sales;Sales\n',
  'ad_memberships.csv': 'group_dn\tmembers\nCN=Sales\tu1;u2\n',
};
function mappedFile(name) {
  return { name, mimeType: 'text/csv', buffer: Buffer.from(MAPPED_FIXTURES[name]) };
}

export function register(test, expect) {
  // The wizard card itself, by its heading. Assertions about what the wizard
  // says must be scoped to it: the configured-crawlers list behind it renders
  // every CSV crawler's own Summary panel, which repeats the same filenames and
  // "N mapped columns" wording. An unscoped getByText is a strict-mode
  // violation as soon as one mapped CSV crawler already exists — which is the
  // normal state of any deployment that has been used, as opposed to the
  // freshly-migrated database CI runs against.
  function wizardCard(page, title) {
    return page.locator('h3', { hasText: title }).locator('xpath=ancestor::div[contains(@class,"p-5")][1]');
  }

  async function openAddCrawler(page) {
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
    await page.click('button:has-text("CSV Import")');
    return true;
  }

  test.describe('CSV crawler wizard — file upload step', () => {
    test('staging files updates the required-object coverage panel', async ({ page }) => {
      if (!await openAddCrawler(page)) return;

      await expect(page.locator('h3:has-text("Add CSV Crawler")')).toBeVisible({ timeout: 10000 });
      await page.click('button:has-text("Next: Upload files")');

      // Nothing uploaded yet — the required slots (Resources/Users/Assignments) are missing.
      await expect(page.getByText('Missing required:')).toBeVisible();
      const nextReview = page.locator('button:has-text("Next: Review")');
      await expect(nextReview).toBeDisabled();

      const fileInput = page.locator('input[type="file"][accept=".csv"]');
      await fileInput.setInputFiles([csvFile('Resources.csv'), csvFile('Users.csv'), csvFile('Assignments.csv')]);

      await expect(page.getByText('Staged files (3)')).toBeVisible();
      await expect(page.getByText('Missing required:')).not.toBeVisible();
      await expect(nextReview).toBeEnabled();

      // Removing a required file re-introduces the gap.
      const resourcesRow = page.locator('div.divide-y > div', { hasText: 'Resources.csv' });
      await resourcesRow.locator('button:has-text("Remove")').click();

      await expect(page.getByText('Staged files (2)')).toBeVisible();
      await expect(page.getByText('Missing required:')).toContainText('Resources.csv');
      await expect(nextReview).toBeDisabled();

      await page.click('button:has-text("Cancel")');
    });

    test('create with real files, then list and delete an uploaded file in edit mode', async ({ page }) => {
      if (!await openAddCrawler(page)) return;

      const name = `E2E CSV Upload Test ${Date.now()}`;
      await page.fill('input[placeholder="e.g. Omada Production"]', name);
      await page.click('button:has-text("Next: Upload files")');

      const fileInput = page.locator('input[type="file"][accept=".csv"]');
      await fileInput.setInputFiles([
        csvFile('Resources.csv'), csvFile('Users.csv'), csvFile('Assignments.csv'), csvFile('Systems.csv'),
      ]);
      await expect(page.getByText('Staged files (4)')).toBeVisible();

      await page.click('button:has-text("Next: Review")');
      await expect(page.getByText('4 total (4 new, 0 existing)')).toBeVisible();
      await page.click('button:has-text("Create crawler")');

      // Wizard closes back to the configured-crawlers list once the config row
      // and all 4 files have actually been persisted server-side.
      await expect(page.locator('h4', { hasText: name })).toBeVisible({ timeout: 10000 });

      // Re-open in edit mode and jump straight to step 2 (allowAll in edit mode).
      const card = page.locator('h4', { hasText: name }).locator('xpath=ancestor::div[contains(@class,"p-4")][1]');
      await card.locator('button:has-text("Configure")').click();
      await expect(page.locator('h3:has-text("Edit CSV Crawler")')).toBeVisible({ timeout: 10000 });
      await page.click('button[aria-label="Go to step 2: Upload files"]');

      // This list is fetched live from GET /admin/crawler-configs/:id/files —
      // a real round trip through the upload routes, not a mocked response.
      await expect(page.getByText('Already uploaded (4)')).toBeVisible({ timeout: 10000 });
      for (const file of ['Resources.csv', 'Users.csv', 'Assignments.csv', 'Systems.csv']) {
        await expect(page.getByText(file)).toBeVisible();
      }

      // Delete one of the already-uploaded (server-side) files. removeServerFile
      // now opens the in-app confirm dialog (audit H-21), not a native
      // window.confirm — confirm it by clicking the modal's danger "Delete"
      // button. DialogProvider renders at the app root, after the page content,
      // so its button is the last "Delete" in the DOM.
      const systemsRow = page.locator('div.divide-y > div', { hasText: 'Systems.csv' });
      await systemsRow.locator('button:has-text("Delete")').click();
      await page.getByRole('button', { name: 'Delete', exact: true }).last().click();

      await expect(page.getByText('Already uploaded (3)')).toBeVisible({ timeout: 10000 });
      await expect(page.getByText('Systems.csv')).not.toBeVisible();

      await page.click('button:has-text("Cancel")');
    });
  });

  // The feature's own acceptance path: a non-schema export loads after mapping
  // its columns in the wizard, the mapping is visible in the stored config, and
  // reopening the crawler shows it again — read back from the server, not from
  // browser state.
  test.describe('CSV crawler wizard — custom column mapping', () => {
    test('maps a non-schema export, saves it, and shows it again on reopen', async ({ page }) => {
      if (!await openAddCrawler(page)) return;

      const name = `E2E CSV Mapping Test ${Date.now()}`;
      const wizard = wizardCard(page, 'Add CSV Crawler');
      await page.fill('input[placeholder="e.g. Omada Production"]', name);
      await page.getByRole('radio', { name: /Custom mapping/ }).check();
      await page.click('button:has-text("Next: Upload files")');

      await page.locator('input[type="file"][accept=".csv"]').setInputFiles([
        mappedFile('ad_people.csv'), mappedFile('ad_groups.csv'), mappedFile('ad_memberships.csv'),
      ]);
      await expect(page.getByText('Staged files (3)')).toBeVisible();

      // Mixed delimiters just work: each file's own is detected and shown.
      await expect(page.getByLabel('CSV delimiter for ad_people.csv')).toHaveValue(',');
      await expect(page.getByLabel('CSV delimiter for ad_groups.csv')).toHaveValue(';');
      await expect(page.getByLabel('CSV delimiter for ad_memberships.csv')).toHaveValue('\t');

      // None of these filenames matches a slot, so the required-object panel is
      // still short of everything until each one is assigned.
      await expect(page.getByText('Missing required:')).toBeVisible();
      await page.getByLabel('Object type for ad_people.csv').selectOption('users');
      await page.getByLabel('Object type for ad_groups.csv').selectOption('resources');
      await page.getByLabel('Object type for ad_memberships.csv').selectOption('assignments');
      await expect(page.getByText('Missing required:')).not.toBeVisible();

      // Required-but-unmapped is flagged per schema field — and Next stays
      // disabled until it is fixed, so a file that cannot load is never saved.
      await expect(page.getByText(/Unmapped required fields: ExternalId, DisplayName/).first()).toBeVisible();
      const nextReview = page.locator('button:has-text("Next: Review")');

      await page.getByLabel('Source column for ExternalId in ad_people.csv').selectOption('samaccountname');
      await page.getByLabel('Source column for DisplayName in ad_people.csv').selectOption('cn');
      await page.getByLabel('Source column for Email in ad_people.csv').selectOption('mail');
      await page.getByLabel('Source column for ExternalId in ad_groups.csv').selectOption('group_dn');
      await page.getByLabel('Source column for DisplayName in ad_groups.csv').selectOption('group_name');
      await page.getByLabel('Source column for ResourceExternalId in ad_memberships.csv').selectOption('group_dn');
      await page.getByLabel('Source column for UserExternalId in ad_memberships.csv').selectOption('members');
      // One row per value out of "u1;u2".
      await page.getByLabel('Multi-value split delimiter for UserExternalId in ad_memberships.csv').fill(';');

      await expect(page.getByText(/Unmapped required field/)).not.toBeVisible();
      await expect(nextReview).toBeEnabled();
      await nextReview.click();

      // The review step states what will be applied, per file.
      await expect(wizard.getByText('Custom mapping')).toBeVisible();
      await expect(wizard.getByText('ad_people.csv', { exact: true })).toBeVisible();
      await expect(wizard.getByText(/3 mapped columns/)).toBeVisible();
      await expect(wizard.getByText(/splits UserExternalId/)).toBeVisible();
      await page.click('button:has-text("Create crawler")');

      await expect(page.locator('h4', { hasText: name })).toBeVisible({ timeout: 10000 });
      const card = page.locator('h4', { hasText: name }).locator('xpath=ancestor::div[contains(@class,"p-4")][1]');
      // The mapping is visible on the card without reopening anything.
      await expect(card.getByText(/7 mapped columns/)).toBeVisible();
      await expect(card.getByText(/ad_people\.csv \(Comma/)).toBeVisible();

      // Reopen: the stored mapping comes back, and the column dropdowns are
      // filled from each file's real header read off the server — the wizard has
      // no File object for an already-uploaded file.
      await card.locator('button:has-text("Configure")').click();
      await expect(page.locator('h3:has-text("Edit CSV Crawler")')).toBeVisible({ timeout: 10000 });
      await page.click('button[aria-label="Go to step 2: Upload files"]');
      await expect(page.getByText('Already uploaded (3)')).toBeVisible({ timeout: 10000 });
      await expect(page.getByLabel('Source column for ExternalId in ad_people.csv')).toHaveValue('samaccountname');
      await expect(page.getByLabel('Source column for UserExternalId in ad_memberships.csv')).toHaveValue('members');
      await expect(page.getByLabel('CSV delimiter for ad_memberships.csv')).toHaveValue('\t');

      await page.click('button:has-text("Cancel")');
    });
  });
}
