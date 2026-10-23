// @ts-check
/**
 * CSV crawler — an EmployeeId column on Users.csv reaches Account Linking (#1441).
 *
 * Reported symptom: an employee number supplied on Users.csv never arrived in
 * Principals.employeeId. Users.csv's canonical schema had no EmployeeId column,
 * so the value rode the extra-column pass-through under the header's own
 * spelling, and the ingest — which matches a record field to a real column
 * case-SENSITIVELY — filed 'EmployeeId' into extendedAttributes. Account
 * Linking's strongest signal (employeeId, weight 95) reads the real column
 * only, so the account stayed orphaned and the detail page showed the number
 * as an extended attribute instead of the Employee ID field.
 *
 * This walks the reporter's exact path against the running stack: Admin →
 * Crawlers → Add Crawler → CSV → upload Users.csv (with EmployeeId) +
 * Identities.csv (matching EmployeeId) + Resources.csv + Assignments.csv →
 * Run → Admin → Account Linking → Run now → the account's detail page and the
 * identity it should now be linked to.
 *
 * The fixture is deliberately built so EmployeeId is the ONLY signal that can
 * link the two: the account and the identity share no name, no email and no
 * email prefix, so every other default signal scores zero. Before the fix the
 * run links nothing and the Employee ID row carries the "ext" badge; after it,
 * the account is linked and the row is a real attribute.
 *
 * Named *.e2e.mjs and exporting register(test, expect) rather than importing
 * @playwright/test — see ConfigWizard.e2e.mjs in this folder for why, and
 * app/ui/e2e/crawler-plugin-tests.spec.js for the loader that calls it.
 */

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3001';
const API = `${BASE}/api`;

/** A crawl + a linking run are both real background work — far past the 30s default. */
const CRAWL_TIMEOUT_MS = 180_000;

function csvFile(name, lines) {
  return { name, mimeType: 'text/csv', buffer: Buffer.from(`${lines.join('\n')}\n`) };
}

/**
 * The four files of the reporter's import, stamped unique per run so repeated
 * runs against one deployment never collide.
 *
 * Account and identity are deliberately disjoint on every signal except
 * EmployeeId: different surnames (so the `fullName` / `surnameInitial` name
 * signals miss), different local parts (so `email` and `emailPrefix` miss).
 * That is what makes a link here evidence that employeeId specifically
 * arrived — and a missing link evidence that it did not.
 */
function fixture(stamp) {
  const employeeId = `E2E${stamp}`;
  const account = { externalId: `u-${stamp}`, displayName: `Zzaccount Tsuser ${stamp}`, email: `zz.tsuser.${stamp}@e2e.invalid` };
  const identity = { externalId: `i-${stamp}`, displayName: `Qqperson Pyrmont ${stamp}`, email: `qq.pyrmont.${stamp}@e2e.invalid` };
  const resource = { externalId: `r-${stamp}`, displayName: `E2E Resource ${stamp}` };
  return {
    employeeId,
    account,
    identity,
    resource,
    files: [
      csvFile('Users.csv', [
        'ExternalId;DisplayName;Email;EmployeeId',
        `${account.externalId};${account.displayName};${account.email};${employeeId}`,
      ]),
      csvFile('Identities.csv', [
        'ExternalId;DisplayName;Email;EmployeeId',
        `${identity.externalId};${identity.displayName};${identity.email};${employeeId}`,
      ]),
      csvFile('Resources.csv', [
        'ExternalId;DisplayName',
        `${resource.externalId};${resource.displayName}`,
      ]),
      csvFile('Assignments.csv', [
        'ResourceExternalId;UserExternalId',
        `${resource.externalId};${account.externalId}`,
      ]),
    ],
  };
}

export function register(test, expect) {
  test.describe('CSV crawler — EmployeeId on Users.csv feeds Account Linking (#1441)', () => {
    test('an account whose only match is EmployeeId is linked, and shows Employee ID as a real attribute', async ({ page, request }) => {
      test.setTimeout(CRAWL_TIMEOUT_MS + 120_000);

      const stamp = `${Date.now()}`;
      const { employeeId, account, identity, files } = fixture(stamp);
      let configId = null;

      try {
        // ─── Admin → Crawlers → Add Crawler → CSV ──────────────────
        await page.goto(`${BASE}/#admin`);
        await page.waitForLoadState('networkidle');
        // .first() — an empty-data install shows a second "Add Crawler" CTA in
        // the welcome banner alongside the toolbar button.
        const addBtn = page.locator('button:has-text("Add Crawler")').first();
        if (!await addBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
          test.skip();
          return;
        }
        await addBtn.click();
        await page.click('button:has-text("CSV Import")');
        await expect(page.locator('h3:has-text("Add CSV Crawler")')).toBeVisible({ timeout: 10000 });

        const crawlerName = `E2E EmployeeId Linking ${stamp}`;
        await page.fill('input[placeholder="e.g. Omada Production"]', crawlerName);
        await page.click('button:has-text("Next: Upload files")');

        await page.locator('input[type="file"][accept=".csv"]').setInputFiles(files);
        await expect(page.getByText('Staged files (4)')).toBeVisible();
        await expect(page.getByText('Missing required:')).not.toBeVisible();

        await page.click('button:has-text("Next: Review")');
        const [configResponse] = await Promise.all([
          page.waitForResponse(r => /\/api\/admin\/crawler-configs(\?|$)/.test(r.url()) && r.request().method() === 'POST'),
          page.click('button:has-text("Create crawler")'),
        ]);
        configId = (await configResponse.json())?.id ?? null;
        expect(configId, 'the wizard created a crawler config').not.toBeNull();

        // ─── Run the crawler ───────────────────────────────────────
        const card = page.locator('h4', { hasText: crawlerName }).locator('xpath=ancestor::div[contains(@class,"p-4")][1]');
        await expect(card).toBeVisible({ timeout: 15000 });
        const [jobResponse] = await Promise.all([
          page.waitForResponse(r => /\/api\/admin\/crawler-jobs(\?|$)/.test(r.url()) && r.request().method() === 'POST'),
          card.locator('button:has-text("Run Full")').click(),
        ]);
        const jobId = (await jobResponse.json())?.id;
        expect(jobId, 'Run Full queued a job').toBeTruthy();

        const job = await waitForTerminal(
          request, `${API}/admin/crawler-jobs/${jobId}`, j => ['completed', 'failed', 'cancelled'].includes(j.status));
        expect(job.status, `crawl finished: ${job.errorMessage || job.status}`).toBe('completed');

        // ─── Admin → Account Linking → Run now ─────────────────────
        await page.goto(`${BASE}/#admin?sub=account-linking`);
        await page.waitForLoadState('networkidle');
        await page.click('button:has-text("Run now")');
        await expect(page.getByText('Linking complete')).toBeVisible({ timeout: 120_000 });

        // ─── The account's detail page ─────────────────────────────
        // Before the fix the number was an extendedAttributes entry, rendered
        // with the faded "ext" badge (title="From extendedAttributes") next to
        // its label. It must now be a real Principals column instead.
        const principalId = await lookupId(request, `${API}/users?search=${encodeURIComponent(account.displayName)}&limit=5`,
          r => r.displayName === account.displayName);
        expect(principalId, `the crawl imported ${account.displayName}`).toBeTruthy();

        await page.goto(`${BASE}/#user:${principalId}`);
        const employeeRow = page.locator('tr', { hasText: 'Employee Id' }).first();
        await expect(employeeRow).toBeVisible({ timeout: 15000 });
        await expect(employeeRow).toContainText(employeeId);
        await expect(employeeRow.locator('[title="From extendedAttributes"]')).toHaveCount(0);

        // ─── The identity it belongs to ────────────────────────────
        const identityId = await lookupId(request, `${API}/identities?search=${encodeURIComponent(identity.displayName)}&limit=5`,
          r => r.displayName === identity.displayName);
        expect(identityId, `the crawl imported ${identity.displayName}`).toBeTruthy();

        await page.goto(`${BASE}/#identity:${identityId}`);
        await expect(page.getByText(account.displayName).first()).toBeVisible({ timeout: 15000 });
      } finally {
        // Best effort — a leftover config would show up as a stray card for
        // every later spec that counts crawlers.
        if (configId) await request.delete(`${API}/admin/crawler-configs/${configId}`).catch(() => {});
      }
    });
  });

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
}
