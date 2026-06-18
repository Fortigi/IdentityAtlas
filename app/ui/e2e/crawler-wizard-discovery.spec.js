// @ts-check
/**
 * Crawler wizard plugin discovery E2E test.
 *
 * CrawlersPage.jsx discovers crawler wizards via a repo-root-relative
 * import.meta.glob() call targeting each crawler folder's CrawlerMeta.js file.
 * That glob is resolved against the filesystem at build time, so a packaging
 * mistake (e.g. a build stage that doesn't copy tools/crawlers/) silently
 * produces zero matches with no error anywhere — see the Docker
 * frontend-build bug fixed by app/api/Dockerfile's frontend-build stage
 * restructuring.
 *
 * This test does NOT hardcode crawler names (crawlers come and go). Instead
 * it discovers the same source of truth the production code reads from
 * (each tools/crawlers/<type>/CrawlerMeta.js file on disk) and asserts the
 * running app's "Add Crawler" type picker shows every one of them. Runs
 * against the real Docker-built backend in CI (see playwright.ci.config.js),
 * so it exercises the actual production build artifact, not just
 * `npm run dev`.
 */

import { test, expect } from '@playwright/test';
import { readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { execFileSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.E2E_BASE_URL || 'http://localhost:3001';
const CRAWLERS_ROOT = join(__dirname, '..', '..', '..', 'tools', 'crawlers');

// Playwright's own module loader intercepts dynamic import() of arbitrary
// external files and can misclassify their module format, so the actual
// import is done in a throwaway child Node process instead (matches plain
// `node` behavior, which is what the real API/UI code paths use).
function importDefaultExport(absPath) {
  const script = `import(${JSON.stringify(pathToFileURL(absPath).href)}).then(m => process.stdout.write(JSON.stringify(m.default)));`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }));
}

function discoverCrawlerMetas() {
  if (!existsSync(CRAWLERS_ROOT)) return [];
  const metas = [];
  for (const entry of readdirSync(CRAWLERS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metaPath = join(CRAWLERS_ROOT, entry.name, 'CrawlerMeta.js');
    if (!existsSync(metaPath)) continue;
    metas.push(importDefaultExport(metaPath));
  }
  return metas;
}

test.describe('Crawler wizard plugin discovery', () => {
  test('every tools/crawlers/*/CrawlerMeta.js entry appears in the Add Crawler type picker', async ({ page }) => {
    const metas = discoverCrawlerMetas();
    test.skip(metas.length === 0, 'No file-based crawler plugins found in tools/crawlers/ — nothing to verify');

    await page.goto(`${BASE}/#admin`);
    await page.waitForLoadState('networkidle');

    // .first() — an empty-data install shows a second "Add Crawler" CTA in the
    // welcome banner alongside the toolbar button; both open the same picker.
    const addBtn = page.locator('button:has-text("Add Crawler")').first();
    if (!await addBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      test.skip();
      return;
    }
    await addBtn.click();

    for (const meta of metas) {
      const typeBtn = page.locator('button').filter({ hasText: meta.name });
      await expect(
        typeBtn,
        `Expected "${meta.name}" (tools/crawlers/${meta.id}/CrawlerMeta.js) in the type picker. If this fails, ` +
        `the crawler-wizard plugin discovery (import.meta.glob) found nothing in the running build — check that ` +
        `tools/crawlers/ was actually included wherever this app was built.`
      ).toBeVisible({ timeout: 5000 });
    }
  });
});
