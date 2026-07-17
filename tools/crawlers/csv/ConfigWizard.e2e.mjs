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

function csvFile(name) {
  return { name, mimeType: 'text/csv', buffer: Buffer.from('ExternalId;DisplayName\n') };
}

export function register(test, expect) {
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
}
