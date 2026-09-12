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
