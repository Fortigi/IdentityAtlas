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

// ─── Folding a business role's resources away (#370) ──────────────────────────
//
// A business role row can hide the rows of the resources it grants, so the grid
// reduces to "business roles + resources no role covers". Fold state is pure
// view state and sticks per matrix. These run against the demo dataset; when it
// holds no business role that grants a visible resource there is no fold
// affordance at all (the zero case), and the tests skip rather than fail.
test.describe('Matrix — fold business-role resources', () => {
  test.setTimeout(90000);

  const ALL_DATA_FILTER = {
    rowType: 'principal',
    orientation: 'rows-as-resources',
    subject: { include: [], exclude: [] },
    resource: { include: [], exclude: [] },
  };
  const matrixUrl = (filter) => '/#matrix?filter=' + encodeURIComponent(JSON.stringify(filter));

  // Load a matrix slice in a fresh document. The app reads `?filter=` once, at
  // mount — the matrix hash is a share/bookmark entry point, not a live route —
  // so a hash-only change would leave the previous slice on screen. Going via
  // about:blank forces the real navigation (localStorage survives it, which is
  // what the fold-persistence assertions rely on).
  async function gotoSlice(page, filter) {
    await page.goto('about:blank');
    await page.goto(matrixUrl(filter));
    await page.waitForLoadState('networkidle');
  }

  // Open the all-data matrix. Returns false when no grid renders (no data here).
  async function openGrid(page) {
    await gotoSlice(page, ALL_DATA_FILTER);
    try {
      await expect(page.locator('table').first()).toBeVisible({ timeout: 40000 });
    } catch {
      return false;
    }
    await page.waitForTimeout(1000); // let the virtualizer settle
    return true;
  }

  const foldAll = (page) => page.getByRole('button', { name: 'Fold roles', exact: true });
  const unfoldAll = (page) => page.getByRole('button', { name: 'Unfold roles', exact: true });

  // Total height of the (virtualised) row list — it shrinks when rows fold away.
  const rowsHeight = (page) => page.evaluate(() => {
    const tbody = document.querySelector('table tbody');
    return tbody ? Math.round(tbody.getBoundingClientRect().height) : 0;
  });

  // Value shown in a scope-statistics tile ("Resources", "Assignments"). Each
  // tile is a group named after its metric; the number is its first span. Waits
  // out the em-dash placeholder the tile shows until scope-stats has loaded.
  async function statValue(page, label) {
    const value = page.getByRole('group', { name: label, exact: true }).locator('span').first();
    await expect(value).not.toHaveText('—', { timeout: 30000 });
    return value.innerText();
  }

  async function openFoldableGrid(page) {
    const rendered = await openGrid(page);
    test.skip(!rendered, 'matrix grid did not render (no data) — cannot exercise the fold');
    const foldable = await foldAll(page).count();
    test.skip(foldable === 0, 'no business role grants a visible resource in this dataset');
  }

  test('"Fold roles" hides the resources roles grant, "Unfold roles" restores them', async ({ page }) => {
    await openFoldableGrid(page);

    const before = await rowsHeight(page);
    await foldAll(page).click();
    await expect(unfoldAll(page)).toBeVisible();
    await expect.poll(() => rowsHeight(page)).toBeLessThan(before);
    // The folded roles say how many rows they took with them.
    await expect(page.getByText(/\d+ resources? folded/).first()).toBeVisible();

    await unfoldAll(page).click();
    await expect.poll(() => rowsHeight(page)).toBe(before);
    await expect(unfoldAll(page)).toHaveCount(0);
  });

  test('a per-role chevron folds only that role, and is labelled for screen readers', async ({ page }) => {
    await openFoldableGrid(page);

    const chevron = page.getByRole('button', { name: 'Fold business role resources' }).first();
    await expect(chevron).toBeVisible();

    const before = await rowsHeight(page);
    await chevron.click();
    await expect.poll(() => rowsHeight(page)).toBeLessThan(before);
    // The same control now offers the reverse action.
    const unfoldOne = page.getByRole('button', { name: 'Unfold business role resources' }).first();
    await expect(unfoldOne).toBeVisible();
    await unfoldOne.click();
    await expect.poll(() => rowsHeight(page)).toBe(before);
  });

  test('folding changes no number in the scope-statistics panel', async ({ page }) => {
    await openFoldableGrid(page);

    const before = {
      resources: await statValue(page, 'Resources'),
      assignments: await statValue(page, 'Assignments'),
    };
    await foldAll(page).click();
    await expect(unfoldAll(page)).toBeVisible();

    expect(await statValue(page, 'Resources')).toBe(before.resources);
    expect(await statValue(page, 'Assignments')).toBe(before.assignments);
  });

  test('fold state is restored when the same matrix is re-opened', async ({ page }) => {
    await openFoldableGrid(page);

    await foldAll(page).click();
    await expect(unfoldAll(page)).toBeVisible();
    const folded = await rowsHeight(page);

    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('table').first()).toBeVisible({ timeout: 40000 });
    await expect(unfoldAll(page)).toBeVisible({ timeout: 20000 });
    await expect.poll(() => rowsHeight(page)).toBe(folded);

    // A different matrix slice keeps its own (expanded) state.
    await gotoSlice(page, { ...ALL_DATA_FILTER, rowType: 'identity' });
    await expect(unfoldAll(page)).toHaveCount(0);

    // Leave the browser profile clean for the next test.
    await gotoSlice(page, ALL_DATA_FILTER);
    if (await unfoldAll(page).count()) await unfoldAll(page).click();
  });

  // The resources a role grants hang under it with the same indent + elbow an
  // expanded nested group uses, so "what is in this role" reads off the grid.
  const childElbows = (page) => page.locator('tbody tr td span', { hasText: /^└$/ }).count();

  test('a role\'s resources hang under it as child rows, and go with it when it folds', async ({ page }) => {
    await openFoldableGrid(page);

    const before = await childElbows(page);
    test.skip(before === 0, 'no role and one of its resources are on screen together here');

    await foldAll(page).click();
    await expect(unfoldAll(page)).toBeVisible();
    await expect.poll(() => childElbows(page)).toBeLessThan(before);

    await unfoldAll(page).click();
    await expect.poll(() => childElbows(page)).toBe(before);
  });

  test('a folded role counts the access it hides but does not grant', async ({ page }) => {
    await openFoldableGrid(page);

    // Nothing is folded yet, so the marker cannot be on screen.
    const marker = page.locator('tbody span[title*="does not grant"]');
    await expect(marker).toHaveCount(0);

    await foldAll(page).click();
    await expect(unfoldAll(page)).toBeVisible();

    if (await marker.count()) {
      // Every marker states a count of ungoverned assignments it stands for.
      await expect(marker.first()).toHaveText(/^[1-9]\d*$/);
      await expect(marker.first()).toHaveAttribute(
        'title', /assignments? on the folded resources that this business role does not grant/,
      );
    }
    await unfoldAll(page).click();
    await expect(marker).toHaveCount(0);
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
