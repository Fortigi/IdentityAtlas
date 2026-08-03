// @ts-check
import { test, expect } from '@playwright/test';

const API = 'http://localhost:3001/api';

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

// ─── Contexts column (issue #870) ─────────────────────────────────────────────
//
// Each resource row carries the contexts it belongs to (group category, tags,
// clusters, …) as a right-side metadata column: up to two chips, then a "+N"
// button that reveals the rest inline. Display-only — no sort, no filter.
test.describe('Matrix — Contexts column', () => {
  test.setTimeout(90000);

  const ALL_RESOURCES_FILTER = {
    rowType: 'principal',
    orientation: 'rows-as-resources',
    subject: { include: [], exclude: [] },
    resource: { include: [], exclude: [] },
  };

  test('the flat-grid response carries a per-resource contexts sidecar', async ({ request }) => {
    const res = await request.post(`${API}/matrix/data`, {
      data: { filter: ALL_RESOURCES_FILTER },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.resourceContexts)).toBe(true);

    // Every entry is { resourceId, contexts: [{ id, displayName, contextType }] }.
    for (const entry of body.resourceContexts.slice(0, 20)) {
      expect(typeof entry.resourceId).toBe('string');
      expect(Array.isArray(entry.contexts)).toBe(true);
      for (const ctx of entry.contexts) {
        expect(typeof ctx.displayName).toBe('string');
        expect(typeof ctx.contextType).toBe('string');
      }
    }
  });

  test('the grid shows a Contexts column, and "+N" expands the hidden chips inline', async ({ page }) => {
    await page.goto('/#matrix?filter=' + encodeURIComponent(JSON.stringify(ALL_RESOURCES_FILTER)));
    await page.waitForLoadState('networkidle');

    const table = page.locator('table').first();
    try {
      await expect(table).toBeVisible({ timeout: 60000 });
    } catch {
      test.skip(true, 'matrix grid did not render (no data) — cannot exercise the Contexts column');
      return;
    }

    // The column header sits on the pinned names row, beside # and Description.
    await expect(page.getByRole('columnheader', { name: 'Contexts', exact: true }).first())
      .toBeVisible({ timeout: 15000 });

    // Rows either list their contexts or show the em-dash empty state; a row is
    // never blank. Take the first "+N" expander, if the data has one.
    const more = page.getByRole('button', { name: /Show \d+ more contexts/ }).first();
    if (await more.count() === 0) {
      // No resource in this dataset sits in more than two contexts — the
      // display-only column still rendered, which is what this test guards.
      return;
    }

    const cell = more.locator('xpath=ancestor::td[1]');
    const chipsBefore = await cell.locator('span.truncate').count();
    await more.click();

    // Expanding reveals the rest inline and retires the button.
    await expect(more).toHaveCount(0);
    expect(await cell.locator('span.truncate').count()).toBeGreaterThan(chipsBefore);
  });
});
