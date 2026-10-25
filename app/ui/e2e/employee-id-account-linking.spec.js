// @ts-check
/**
 * An imported employee number reaches Account Linking, and shows as a real
 * attribute rather than an extended one (#1441).
 *
 * Reported symptom: an employee number supplied on the import's user file never
 * arrived in `Principals.employeeId`. The user file's canonical schema had no
 * EmployeeId column, so the value rode the extra-column pass-through under the
 * header's own spelling, and the ingest — which matches a record field to a real
 * column case-SENSITIVELY (`pickCoreColumns` in ingest/normalization.js) — filed
 * `EmployeeId` into `extendedAttributes`. Account Linking's strongest signal
 * (employeeId, weight 95 in accountlinking/defaultRules.js) reads the real
 * column only, so the account stayed orphaned, and the detail page rendered the
 * number as an extended attribute instead of the Employee Id field. Both
 * spellings humanise to the same "Employee Id" label, which is why the symptom
 * was invisible on the page until you looked for the "ext" badge.
 *
 * This walks the reporter's path against the running stack: Admin → Crawlers →
 * Add Crawler → fill in the product's own downloadable templates → Run → Admin →
 * Account Linking → Run now → the account's detail page and the identity it
 * should now be linked to.
 *
 * Lives here rather than beside a crawler plugin because what it covers is core:
 * the ingest's core-column matching, Account Linking's employeeId signal, and
 * the detail page's core-vs-extended attribute rendering. The file import is
 * only the vehicle for getting an employee number into the database, so the
 * crawler is discovered from `crawler.json`'s `supportsFileUploads` flag and its
 * templates read off disk — no crawler type is named here (the same rule the
 * `crawler-manifest` CI gate enforces for app/ui and app/api).
 */

import { test, expect } from '@playwright/test';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  E2E_BASE, E2E_API, openCrawlerWizard, deleteCrawlerConfigs,
} from '../../../tools/crawlers/shared/wizardE2EKit.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CRAWLERS_ROOT = join(__dirname, '..', '..', '..', 'tools', 'crawlers');

/** A crawl and a linking run are both real background work — far past the 30s default. */
const CRAWL_TIMEOUT_MS = 180_000;

/**
 * The crawler plugin whose manifest says it imports uploaded files, together
 * with its upload templates — or null when this build ships no such plugin.
 */
function discoverUploadCrawler() {
  if (!existsSync(CRAWLERS_ROOT)) return null;
  for (const entry of readdirSync(CRAWLERS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(CRAWLERS_ROOT, entry.name);
    const manifestPath = join(dir, 'crawler.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!manifest.supportsFileUploads) continue;
    const schemaDir = join(dir, 'schema');
    if (!existsSync(schemaDir)) continue;
    return { manifest, schemaDir };
  }
  return null;
}

/** The header line of one shipped upload template. */
function templateHeader(schemaDir, fileName) {
  return readFileSync(join(schemaDir, fileName), 'utf8').split(/\r?\n/)[0].trim();
}

/**
 * Fill in one of the product's own downloadable templates.
 *
 * The header comes from the shipped template, so the column spellings and the
 * delimiter are the ones the product tells users to send — which is the part
 * #1441 broke: a template without an EmployeeId column is a template whose
 * employee numbers can only ever arrive as extended attributes. Only the
 * columns `values` supplies are emitted, in template order, the way a reporter
 * fills in the subset they have; a key that the template does not declare is an
 * error rather than a silently dropped column.
 */
function filledTemplate(schemaDir, fileName, values) {
  const header = templateHeader(schemaDir, fileName);
  const delimiter = header.includes(';') ? ';' : ',';
  const columns = header.split(delimiter);
  const missing = Object.keys(values).filter(key => !columns.includes(key));
  expect(missing, `${fileName}'s shipped template declares ${missing.join(', ')}`).toEqual([]);

  const used = columns.filter(column => column in values);
  const lines = [used.join(delimiter), used.map(column => values[column]).join(delimiter)];
  return { name: fileName, mimeType: 'text/plain', buffer: Buffer.from(`${lines.join('\n')}\n`) };
}

/**
 * The four files of the reporter's import, stamped unique per run so repeated
 * runs against one deployment never collide.
 *
 * Account and identity are deliberately disjoint on every signal except the
 * employee number: different display names and surnames (so the `fullName` and
 * `surnameInitial` signals miss) and different email local parts (so `email` and
 * `emailPrefix` miss). That is what makes a link here evidence that the employee
 * number specifically arrived — and a missing link evidence that it did not.
 */
function fixture(schemaDir, stamp) {
  const employeeId = `E2E${stamp}`;
  const account = {
    ExternalId: `u-${stamp}`,
    DisplayName: `Zzaccount Tsuser ${stamp}`,
    Email: `zz.tsuser.${stamp}@e2e.invalid`,
    EmployeeId: employeeId,
    GivenName: 'Zzaccount',
    Surname: `Tsuser ${stamp}`,
  };
  const identity = {
    ExternalId: `i-${stamp}`,
    DisplayName: `Qqperson Pyrmont ${stamp}`,
    Email: `qq.pyrmont.${stamp}@e2e.invalid`,
    EmployeeId: employeeId,
  };
  const resource = { ExternalId: `r-${stamp}`, DisplayName: `E2E Resource ${stamp}` };
  return {
    employeeId,
    account,
    identity,
    files: [
      filledTemplate(schemaDir, 'Users.csv', account),
      filledTemplate(schemaDir, 'Identities.csv', identity),
      filledTemplate(schemaDir, 'Resources.csv', resource),
      filledTemplate(schemaDir, 'Assignments.csv', {
        ResourceExternalId: resource.ExternalId,
        UserExternalId: account.ExternalId,
      }),
    ],
  };
}

/** Poll a JSON endpoint until `done(body)`, or fail with the last body seen. */
async function waitForTerminal(request, url, done) {
  const deadline = Date.now() + CRAWL_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    const r = await request.get(url);
    if (r.ok()) {
      last = await r.json();
      if (done(last)) return last;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out waiting for ${url}; last seen: ${JSON.stringify(last)}`);
}

/** The id of the first row of a list endpoint matching `match`, or null. */
async function lookupId(request, url, match) {
  const r = await request.get(url);
  if (!r.ok()) return null;
  const body = await r.json();
  return (Array.isArray(body) ? body : body.data || []).find(match)?.id ?? null;
}

/**
 * The detail-page attribute row for one label, asserted to be a REAL column
 * rather than an extendedAttributes entry.
 *
 * The "ext" badge (title="From extendedAttributes", EntityDetailLayout.jsx) is
 * the only thing on the page that tells the two apart — `EmployeeId` under
 * extendedAttributes and the real `employeeId` column both humanise to
 * "Employee Id".
 */
async function expectCoreAttribute(page, label, value) {
  const row = page.locator('tr', { hasText: label }).first();
  await expect(row).toBeVisible({ timeout: 15000 });
  await expect(row).toContainText(value);
  await expect(row.locator('[title="From extendedAttributes"]')).toHaveCount(0);
}

test.describe('Employee number feeds Account Linking (#1441)', () => {
  test('an account whose only match is its employee number is linked, and shows it as a real attribute', async ({ page, request }) => {
    test.setTimeout(CRAWL_TIMEOUT_MS + 120_000);

    const plugin = discoverUploadCrawler();
    test.skip(!plugin, 'This build ships no file-upload crawler — nothing to import through');

    const stamp = `${Date.now()}`;
    const { employeeId, account, identity, files } = fixture(plugin.schemaDir, stamp);
    const crawlerName = `E2E Employee Number Linking ${stamp}`;

    try {
      // ─── Admin → Crawlers → Add Crawler → the file-import crawler ──────
      const opened = await openCrawlerWizard({
        page, test, expect, typeLabel: plugin.manifest.displayName,
      });
      if (!opened) return;

      await page.fill('input[placeholder="e.g. Omada Production"]', crawlerName);
      await page.click('button:has-text("Next: Upload files")');

      const accept = plugin.manifest.uploadFileExtensions.join(',');
      await page.locator(`input[type="file"][accept="${accept}"]`).setInputFiles(files);
      await expect(page.getByText(`Staged files (${files.length})`)).toBeVisible();
      await expect(page.getByText('Missing required:')).not.toBeVisible();

      await page.click('button:has-text("Next: Review")');
      const [configResponse] = await Promise.all([
        page.waitForResponse(r => /\/api\/admin\/crawler-configs(\?|$)/.test(r.url()) && r.request().method() === 'POST'),
        page.click('button:has-text("Create crawler")'),
      ]);
      expect((await configResponse.json())?.id, 'the wizard created a crawler config').toBeTruthy();

      // ─── Run the crawler ──────────────────────────────────────────────
      const card = page.locator('h4', { hasText: crawlerName }).locator('xpath=ancestor::div[contains(@class,"p-4")][1]');
      await expect(card).toBeVisible({ timeout: 15000 });
      const [jobResponse] = await Promise.all([
        page.waitForResponse(r => /\/api\/admin\/crawler-jobs(\?|$)/.test(r.url()) && r.request().method() === 'POST'),
        card.locator('button:has-text("Run Full")').click(),
      ]);
      const jobId = (await jobResponse.json())?.id;
      expect(jobId, 'Run Full queued a job').toBeTruthy();

      const job = await waitForTerminal(
        request, `${E2E_API}/admin/crawler-jobs/${jobId}`, j => ['completed', 'failed', 'cancelled'].includes(j.status));
      expect(job.status, `crawl finished: ${job.errorMessage || job.status}`).toBe('completed');

      // ─── Admin → Account Linking → Run now ────────────────────────────
      await page.goto(`${E2E_BASE}/#admin?sub=account-linking`);
      await page.waitForLoadState('networkidle');
      await page.click('button:has-text("Run now")');
      await expect(page.getByText('Linking complete')).toBeVisible({ timeout: 120_000 });

      // ─── The account's detail page ────────────────────────────────────
      const principalId = await lookupId(request, `${E2E_API}/users?search=${encodeURIComponent(account.DisplayName)}&limit=5`,
        r => r.displayName === account.DisplayName);
      expect(principalId, `the crawl imported ${account.DisplayName}`).toBeTruthy();

      await page.goto(`${E2E_BASE}/#user:${principalId}`);
      await expectCoreAttribute(page, 'Employee Id', employeeId);
      await expectCoreAttribute(page, 'Given Name', account.GivenName);
      await expectCoreAttribute(page, 'Surname', account.Surname);

      // ─── The identity it belongs to ───────────────────────────────────
      const identityId = await lookupId(request, `${E2E_API}/identities?search=${encodeURIComponent(identity.DisplayName)}&limit=5`,
        r => r.displayName === identity.DisplayName);
      expect(identityId, `the crawl imported ${identity.DisplayName}`).toBeTruthy();

      await page.goto(`${E2E_BASE}/#identity:${identityId}`);
      await expect(page.getByText(account.DisplayName).first()).toBeVisible({ timeout: 15000 });
    } finally {
      // Best effort — a leftover config would show up as a stray card for every
      // later spec that counts crawlers.
      await deleteCrawlerConfigs(name => name === crawlerName);
    }
  });
});
