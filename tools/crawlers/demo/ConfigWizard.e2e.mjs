// @ts-check
// Regression: matrix loads after demo import without error flash
//
// Covers the bug where useMatrix cached hasData=false on mount and never
// re-checked, causing the Matrix tab to stay blank after a demo import until
// the user forced a page refresh. Also covers the "Backend not responding"
// flash caused by a spurious POST with a null filter during the debounce window.
//
// Requires the full Docker stack (USE_SQL=true + worker). Skipped in mock mode.

const API = 'http://localhost:3001/api';

/** @param {import('@playwright/test').TestType} test @param {import('@playwright/test').Expect} expect */
export function register(test, expect) {
  test.describe('Matrix loads after demo import', () => {
    // Reload demo data after this describe block so the rest of the suite
    // still sees a populated DB (this block wipes the DB as part of the test).
    test.afterAll(async ({ request }) => {
      const cleanRes = await request.post(`${API}/admin/clean-database`);
      if (!cleanRes.ok()) return; // mock mode — nothing to restore
      const jobRes = await request.post(`${API}/admin/crawler-jobs`, { data: { jobType: 'demo' } });
      if (!jobRes.ok()) return;
      const { id } = await jobRes.json();
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 3000));
        const poll = await request.get(`${API}/admin/crawler-jobs/${id}`);
        const { status } = await poll.json();
        if (status === 'completed' || status === 'failed') break;
      }
    });

    test('matrix renders without error after importing demo data from empty DB', async ({ page, request }) => {
      test.setTimeout(180000); // demo import + polling can take up to 2 min
      // Only runs against the Docker stack — clean-database requires USE_SQL=true.
      const cleanRes = await request.post(`${API}/admin/clean-database`);
      if (cleanRes.status() === 503) {
        test.skip(true, 'clean-database not available in mock mode — skipping Docker-only test');
        return;
      }
      expect(cleanRes.ok()).toBe(true);

      // Step 1: visit Matrix tab while DB is empty — hook caches hasData=false.
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      const matrixTab = page.getByRole('button', { name: /^matrix$/i })
        .or(page.getByRole('link', { name: /^matrix$/i }))
        .or(page.getByRole('tab', { name: /^matrix$/i }))
        .first();
      await matrixTab.click();
      await page.waitForTimeout(2000);
      await expect(page.locator('body')).not.toContainText('Backend not responding');

      // Step 2: navigate away so a return trip counts as fresh navigation.
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      // Step 3: submit demo import job and wait for completion.
      const workerKey = await request.get(`${API.replace('/api', '')}/api/admin/worker-key`)
        .then(r => r.ok() ? r.text() : null)
        .catch(() => null);
      const jobRes = await request.post(`${API}/admin/crawler-jobs`, {
        data: { jobType: 'demo' },
        headers: workerKey ? { Authorization: `Bearer ${workerKey}` } : {},
      });
      expect(jobRes.ok()).toBe(true);
      const job = await jobRes.json();

      // Poll until completed (or 2 min).
      const deadline = Date.now() + 120000;
      let status = job.status;
      while (['queued', 'running'].includes(status) && Date.now() < deadline) {
        await page.waitForTimeout(3000);
        const poll = await request.get(`${API}/admin/crawler-jobs/${job.id}`);
        status = (await poll.json()).status;
      }
      expect(status).toBe('completed');

      // Step 4: navigate to Matrix — refetchPreChecks fires, default filter auto-applies.
      const matrixTab2 = page.getByRole('button', { name: /^matrix$/i })
        .or(page.getByRole('link', { name: /^matrix$/i }))
        .or(page.getByRole('tab', { name: /^matrix$/i }))
        .first();
      await matrixTab2.click();
      await page.waitForTimeout(4000); // allow refetch + debounce + data fetch

      // Assert: no error screen, matrix rendered.
      await expect(page.locator('body')).not.toContainText('Backend not responding');
      await expect(page.locator('table').first()).toBeVisible({ timeout: 10000 });
    });
  });
}
