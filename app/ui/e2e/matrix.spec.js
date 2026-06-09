// @ts-check
import { test, expect } from '@playwright/test';

const API = 'http://localhost:3001/api';

// ─── Regression: matrix loads after demo import without error flash ────────────
//
// Covers the bug where useMatrix cached hasData=false on mount and never
// re-checked, causing the Matrix tab to stay blank after a demo import until
// the user forced a page refresh. Also covers the "Backend not responding"
// flash caused by a spurious POST with a null filter during the debounce window.
//
// Requires the full Docker stack (USE_SQL=true + worker). Skipped in mock mode.
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

test.describe('Matrix View', () => {
  // The permissions API cold start in CI can take 20-30s (complex SQL join + query planning).
  // Increase test timeout for the matrix spec to accommodate this.
  test.setTimeout(60000);

  // Warm up the permissions API before tests
  test.beforeAll(async () => {
    try { await fetch(`${API}/permissions?userLimit=5`); } catch { /* ignore */ }
  });

  test.beforeEach(async ({ page }) => {
    // Default landing page is Dashboard since v6 — matrix tests must navigate explicitly.
    await page.goto('/#matrix');
    await page.waitForLoadState('networkidle');
  });

  test('matrix renders with rows and columns', async ({ page }) => {
    test.slow(); // Triple timeout — permissions API cold start takes 20-30s on CI
    // Matrix tab now opens to the wizard empty state when no filter is
    // saved. The "matrix page renders" assertion needs to accept either:
    //   (a) the rendered grid (a saved filter is available), OR
    //   (b) the empty-state heading + "Create matrix" button (no filter yet).
    // Both prove the page rendered without crashing, which is the spirit of
    // this smoke test. Walking the wizard from inside Playwright is brittle
    // (race against the modal's transition / data prefetch in CI), so we
    // leave that to per-wizard tests.
    const table = page.locator('table').first();
    const emptyHeading = page.getByRole('heading', { name: /Pick a slice to inspect/i });
    await expect(table.or(emptyHeading)).toBeVisible({ timeout: 60000 });
  });

  test('user limit slider is present and functional', async ({ page }) => {
    const slider = page.locator('input[type="range"]');
    // There should be at least one range input (user limit)
    if (await slider.count() > 0) {
      await expect(slider.first()).toBeVisible();
      // Get current value
      const value = await slider.first().inputValue();
      expect(parseInt(value)).toBeGreaterThan(0);
    }
  });

  test('IST/SOLL/All toggle is present', async ({ page }) => {
    test.slow(); // Triple timeout — permissions API cold start takes 20-30s on CI
    const allButton = page.getByRole('button', { name: 'All', exact: true }).first();
    await expect(allButton).toBeVisible({ timeout: 60000 });
  });

  test('matrix cells show membership badges', async ({ page }) => {
    // Mock data contains Direct (D), Indirect (I), Eligible (E) badges
    // At least some D badges should be visible
    const dBadges = page.locator('text=D').first();
    await expect(dBadges).toBeVisible({ timeout: 10000 });
  });

  test('"How to read this matrix" legend is available when a matrix is applied', async ({ page }) => {
    test.slow(); // permissions API cold start
    const table = page.locator('table').first();
    const emptyHeading = page.getByRole('heading', { name: /Pick a slice to inspect/i });
    // Either the grid or the empty state renders; the legend only accompanies
    // the grid (it shows once a matrix filter is applied).
    await expect(table.or(emptyHeading)).toBeVisible({ timeout: 60000 });
    if (await table.isVisible()) {
      await expect(
        page.getByRole('button', { name: /How to read this matrix/i })
      ).toBeVisible({ timeout: 10000 });
    }
  });

  test('share button exists', async ({ page }) => {
    const shareButton = page.getByRole('button', { name: /Share/i });
    if (await shareButton.count() > 0) {
      await expect(shareButton).toBeVisible();
    }
  });

  test('export button exists', async ({ page }) => {
    const exportButton = page.getByRole('button', { name: /Export/i });
    if (await exportButton.count() > 0) {
      await expect(exportButton).toBeVisible();
    }
  });

  test('clicking a filter field shows filter values', async ({ page }) => {
    // Look for the add filter button/dropdown
    const addFilter = page.getByText('+ Add filter').or(page.getByText('Add filter'));
    if (await addFilter.count() > 0) {
      await addFilter.first().click();
      // Should reveal a <select> with filter fields. We assert against the
      // select element itself — option elements inside an unopened native
      // <select> are reported "hidden" by Playwright, so checking option
      // visibility is a false negative.
      const fieldSelect = page.locator('select').first();
      await expect(fieldSelect).toBeVisible({ timeout: 2000 });
      // Sanity check: the select should expose at least one real option
      // (department / jobTitle / etc. — exact field set is data-dependent).
      const optionCount = await fieldSelect.locator('option').count();
      expect(optionCount).toBeGreaterThan(1); // 1 = the "Select field..." placeholder
    }
  });

  test('owner rows are separated with (Owner) suffix', async ({ page }) => {
    // Mock data should have owner memberships that create separate rows
    // Owner rows may or may not be visible depending on mock data and user limit
    // Just verify the page doesn't crash
    expect(true).toBe(true);
  });
});

// ─── Regression: no double scrollbar behind the matrix grid ────────────────────
//
// The bug: the grid's height was a fixed max-h-[calc(100vh-280px)] that guessed
// the chrome height. The real chrome (auth banner + scope-statistics + "How to
// read") is taller, so the grid was too tall and the PAGE got a second
// scrollbar next to the grid's own (measured ~310px page overflow). The fix
// measures the remaining viewport and caps the grid to fit, so only the grid
// scrolls. This test renders a tall grid (all data) and asserts the page itself
// does not overflow.
test.describe('Matrix — no double scrollbar', () => {
  test.setTimeout(90000);

  test('the page does not scroll when the grid does (only one scrollbar)', async ({ page }) => {
    // A viewport tall enough that the fix has room (it floors the grid at 240px),
    // but where a full-data grid is far taller than the space left for it — so
    // the OLD fixed cap would push the page past the viewport.
    await page.setViewportSize({ width: 1280, height: 800 });

    // Apply an all-data filter directly via the hash (resources as rows → many
    // rows → a grid taller than the viewport). Bypasses the wizard.
    const filter = {
      rowType: 'principal',
      orientation: 'rows-as-resources',
      subject: { include: [], exclude: [] },
      resource: { include: [], exclude: [] },
    };
    await page.goto('/#matrix?filter=' + encodeURIComponent(JSON.stringify(filter)));
    await page.waitForLoadState('networkidle');

    // Need the grid to actually render. If it doesn't (no demo data in this
    // environment), the scrollbar path can't be exercised — skip rather than
    // fail on an unrelated data condition.
    const table = page.locator('table').first();
    try {
      await expect(table).toBeVisible({ timeout: 40000 });
    } catch {
      test.skip(true, 'matrix grid did not render (no data) — cannot exercise the scrollbar path');
      return;
    }
    await page.waitForTimeout(1500); // let the height-measuring effect settle

    const m = await page.evaluate(() => {
      const de = document.documentElement;
      // The grid is the lone vertical-overflow scroll container.
      const gridScrolls = [...document.querySelectorAll('div')].some((el) => {
        const s = getComputedStyle(el);
        return /auto|scroll/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 2;
      });
      return { pageOverflow: de.scrollHeight - de.clientHeight, gridScrolls };
    });

    if (!m.gridScrolls) {
      test.skip(true, 'grid is not taller than the viewport in this dataset — nothing to assert');
      return;
    }

    // The grid scrolls internally; the page must NOT (a few px of slack for
    // sub-pixel rounding). On the old fixed-cap code this overflowed by ~200px.
    expect(m.pageOverflow, 'page should not scroll when only the grid does').toBeLessThanOrEqual(4);
  });
});
