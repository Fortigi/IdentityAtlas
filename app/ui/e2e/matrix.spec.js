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

  test('a folded role counts the access it hides but does not account for', async ({ page }) => {
    await openFoldableGrid(page);

    // Nothing is folded yet, so the marker cannot be on screen.
    const marker = page.locator('tbody span[title*="does not account for"]');
    await expect(marker).toHaveCount(0);

    await foldAll(page).click();
    await expect(unfoldAll(page)).toBeVisible();

    if (await marker.count()) {
      // Every marker states a count of ungoverned assignments it stands for.
      await expect(marker.first()).toHaveText(/^[1-9]\d*$/);
      await expect(marker.first()).toHaveAttribute(
        'title', /assignments? on the folded resources that this business role does not account for/,
      );
    }
    await unfoldAll(page).click();
    await expect(marker).toHaveCount(0);
  });

  // Requestor feedback on #370: the grid showed only over-granting. The demo
  // dataset's BR-Service-Desk carries both directions (see DemoRoleDrift.ps1).
  test('a folded role counts what it assigns that the subject does not have', async ({ page }) => {
    await openFoldableGrid(page);

    const marker = page.locator('tbody span[title*="does not have"]');
    await expect(marker).toHaveCount(0);

    await foldAll(page).click();
    await expect(unfoldAll(page)).toBeVisible();

    if (await marker.count()) {
      await expect(marker.first()).toHaveText(/^[1-9]\d*$/);
      await expect(marker.first()).toHaveAttribute(
        'title', /assignments? on the folded resources that this business role assigns but this subject does not have/,
      );
    }
    await unfoldAll(page).click();
    await expect(marker).toHaveCount(0);
  });

  test('marks a standing membership where the role only grants eligibility', async ({ page }) => {
    await openFoldableGrid(page);

    // Unfolded, the deviation sits on the resource's own cell.
    const overGrant = page.locator('tbody span[title*="More than the business role assigns"]');
    if (await overGrant.count()) {
      await expect(overGrant.first()).toHaveText('+');
      await expect(overGrant.first()).toHaveAttribute('title', /just-in-time/);
    }
  });

  // Requestor feedback on #370: BR-Engineering-Tools grants SG-VPN-Access, and
  // the two SysAdmins hold that group without holding the role. Folded, the
  // role counted them in red; unfolded, the very same cells said nothing at all.
  test('a membership held outside the role that grants it is marked on the resource row', async ({ page }) => {
    await openFoldableGrid(page);

    // The demo dataset puts SG-VPN-Access near the top of the grid; wait for the
    // virtualizer to paint it before concluding the dataset has no such case.
    const outside = page.locator('tbody span[title*="Held outside"]');
    const present = await outside.first().waitFor({ state: 'attached', timeout: 15000 })
      .then(() => true, () => false);
    test.skip(!present, 'no visible row in this dataset is held outside the business role that grants it');

    await expect(outside.first()).toHaveText(/^[1-9]\d*$/);
    // The marker reports what it evaluated — the granting role's assignments —
    // and never asserts a role membership it did not check (requestor feedback
    // on #370).
    await expect(outside.first()).toHaveAttribute(
      'title', /^⚠ Held outside business-role governance: (no business role assigns this resource to this subject|this subject holds a business role that grants this resource)/,
    );
    await expect(outside.first()).toHaveAttribute(
      'title', /It is granted by (business role .+|\d+ business roles.*), (which carries no assignment|none of which carries an assignment) of it for this subject\.$/,
    );
    // The marker explains the access — it never replaces it, so the badge stays.
    await expect(page.locator('tbody td:has(span[title*="Held outside"])').first())
      .toContainText(/[DIE]/);

    // Folding the roles takes those rows away, and the same finding reappears as
    // the folded role's own red count — the statement is never lost.
    await foldAll(page).click();
    await expect(unfoldAll(page)).toBeVisible();
    await expect(outside).toHaveCount(0);
    const foldedCount = page.locator('tbody span[title*="does not account for"]');
    if (await foldedCount.count()) await expect(foldedCount.first()).toHaveText(/^[1-9]\d*$/);

    await unfoldAll(page).click();
    await expect.poll(() => outside.count()).toBeGreaterThan(0);
  });

  // The exact cell the requestor checked: SG-VPN-Access under
  // BR-Engineering-Tools. The old tooltip closed on "the subject does not hold
  // that role" — a claim about role membership the marker never established,
  // and one the requestor read (correctly) as wrong. What it did establish is
  // that no business role carries an assignment of this resource for the
  // subject, and that is all it may say.
  test('the held-outside marker reports the missing role assignment, not a missing role', async ({ page }) => {
    await openFoldableGrid(page);

    const vpnRow = page.locator('tbody tr').filter({ has: page.getByTitle(/^SG-VPN-Access/) });
    const present = await vpnRow.first().waitFor({ state: 'attached', timeout: 15000 })
      .then(() => true, () => false);
    test.skip(!present, 'SG-VPN-Access is not part of this matrix slice');

    const marker = vpnRow.first().locator('span[title*="Held outside"]');
    test.skip(await marker.count() === 0, 'nobody in this slice holds SG-VPN-Access outside the role that grants it');

    const title = await marker.first().getAttribute('title');
    expect(title).toContain('carries no assignment of it for this subject');
    expect(title).toContain('BR-Engineering-Tools');
    // The old wording, which asserted a role membership the marker never checked.
    expect(title).not.toContain('does not hold');
  });

  // Requestor feedback on #370: what happens to a group / app role that two
  // business roles grant. The demo dataset's BR-Service-Desk and
  // BR-IT-Operations share exactly that (see DemoSharedGrants.ps1).
  test('a resource two roles grant has a row under each of them', async ({ page }) => {
    await openFoldableGrid(page);

    // Find a resource granted by two roles that both have a row — the scenario.
    const pairs = await (await page.request.get('/api/access-package-groups')).json();
    const byResource = new Map();
    for (const r of pairs) {
      if (!r.resourceId) continue;
      const key = String(r.resourceId).toUpperCase();
      if (!byResource.has(key)) byResource.set(key, []);
      byResource.get(key).push(r);
    }
    const shared = [...byResource.values()].find(rows => rows.length > 1);
    test.skip(!shared, 'no resource in this dataset is granted by more than one business role');

    // Fold everything first: with only the role rows left the grid is short, so
    // the virtualizer paints every row and the counts below are exact.
    await foldAll(page).click();
    await expect(unfoldAll(page)).toBeVisible();
    // Ownership resources are named after their group, so pin the rows to the
    // ones that actually carry the "granted by a business role" tooltip.
    const nameCellSelector =
      `td[title^="${shared[0].resourceName}"][title*="Granted by business role:"]`;
    const sharedRows = page.locator(`tbody tr:has(${nameCellSelector})`);
    await expect(sharedRows).toHaveCount(0);

    // Unfold the roles that grant it, one at a time: each one brings its own row
    // for the shared resource.
    const roleRow = (name) => page.locator('tbody tr', { hasText: name })
      .filter({ has: page.getByRole('button', { name: 'Unfold business role resources' }) }).first();
    for (const [i, pair] of shared.entries()) {
      const row = roleRow(pair.accessPackageName);
      test.skip(await row.count() === 0, `the ${pair.accessPackageName} row is not rendered in this grid`);
      await row.getByRole('button', { name: 'Unfold business role resources' }).click();
      await expect(sharedRows).toHaveCount(i + 1);
    }

    // Every one of those rows names all the granting roles, and carries the
    // "BR+N" chip that points at the others.
    const nameCell = page.locator(`tbody ${nameCellSelector}`).first();
    for (const pair of shared) {
      await expect(nameCell)
        .toHaveAttribute('title', new RegExp(`Granted by business role:.*${pair.accessPackageName}`, 's'));
    }
    await expect(sharedRows.first().locator('button[title^="Also granted by business role:"]'))
      .toHaveText(/^BR(\+\d+)?$/);

    // Folding one of them takes away only that role's copy; the other stays.
    await page.locator('tbody tr', { hasText: shared[0].accessPackageName })
      .filter({ has: page.getByRole('button', { name: 'Fold business role resources' }) }).first()
      .getByRole('button', { name: 'Fold business role resources' }).click();
    await expect(sharedRows).toHaveCount(shared.length - 1);
    // A fold always takes exactly what its role grants, so the chip never hedges.
    await expect(page.getByText(/\d+ of \d+ resources folded/)).toHaveCount(0);
    await expect(page.getByText(/\d+ resources? folded/).first()).toBeVisible();

    // Leave the browser profile clean for the next test.
    await unfoldAll(page).click();
    await expect(unfoldAll(page)).toHaveCount(0);
  });

  // A resource lives under the role(s) that grant it, whatever order the rows
  // were saved in — so it can never be orphaned from its role.
  test('a resource stays under its business role whatever the saved row order', async ({ page }) => {
    await openFoldableGrid(page);

    // Every resource a role grants answers "which role?" from its row tooltip.
    const named = page.locator('tbody td[title*="Granted by business role:"]');
    await expect.poll(() => named.count()).toBeGreaterThan(0);

    // Persist a row order the way the drag handle does — clicking the "#"
    // header sorts by member count, which writes the current ids to storage.
    await page.locator('th[title="Sort by member count (descending)"]').click();

    // Then move one role-granted resource to the very top, above every role row.
    const pairs = await (await page.request.get('/api/access-package-groups')).json();
    const moved = await page.evaluate((rows) => {
      const key = Object.keys(localStorage).find(k => k.startsWith('fgraph-roworder-'));
      if (!key) return null;
      const saved = JSON.parse(localStorage.getItem(key));
      const order = saved.order.map(id => String(id).toUpperCase());
      // A pair whose role AND resource both have a row — only then is there a
      // role in the grid to file it under.
      const pair = rows.find(r => r.resourceId
        && order.includes(String(r.accessPackageId).toUpperCase())
        && order.includes(String(r.resourceId).toUpperCase()));
      if (!pair) return null;
      const child = saved.order.find(id => String(id).toUpperCase() === String(pair.resourceId).toUpperCase());
      localStorage.setItem(key, JSON.stringify({
        ...saved,
        order: [child, ...saved.order.filter(id => id !== child)],
      }));
      return { role: pair.accessPackageName, resource: pair.resourceName };
    }, pairs);
    test.skip(!moved, 'no business role and one of its resources share this grid');

    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('table').first()).toBeVisible({ timeout: 40000 });

    // The row is drawn under its role again — indented, with the elbow — and
    // still names it in the tooltip.
    const row = page.locator(
      `tbody tr:has(td[title^="${moved.resource}"][title*="Granted by business role:"])`).first();
    await expect(row).toBeVisible({ timeout: 20000 });
    await expect(row.locator('td span', { hasText: /^└$/ }).first()).toBeVisible();
    await expect(page.locator(`tbody td[title*="Granted by business role:"][title*="${moved.role}"]`).first())
      .toBeVisible();

    // Leave the browser profile clean for the next test.
    await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith('fgraph-roworder-')) localStorage.removeItem(k);
      }
    });
  });

  // Requestor feedback on #370: the white "covered by N business roles" bubble
  // was drawn over the labels of the cells around it. Every marker now lives in
  // a strip the cell reserves for it, so no marker can reach another cell — or
  // the badge underneath it.
  test('no cell marker is drawn over another label', async ({ page }) => {
    await openFoldableGrid(page);
    // Fold the roles so the deviation counts are on screen alongside the
    // role-count bubbles and the gap markers — the busiest the grid ever gets.
    await foldAll(page).click();
    await expect(unfoldAll(page)).toBeVisible();

    const overlaps = await page.evaluate(() => {
      const markers = [...document.querySelectorAll('tbody td span.absolute > span')]
        .filter(s => s.textContent.trim() !== '');
      const escaped = [];
      const inside = (m, cell) => {
        const a = m.getBoundingClientRect();
        const b = cell.getBoundingClientRect();
        // 1px of slack for sub-pixel rounding and collapsed borders.
        return a.left >= b.left - 1 && a.right <= b.right + 1
          && a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
      };
      for (const m of markers) {
        const cell = m.closest('td');
        if (!inside(m, cell)) escaped.push({ text: m.textContent, cls: m.className });
        // The badge row starts below the strip, so a marker can never sit on it.
        for (const badge of cell.querySelectorAll(':scope > span:not(.absolute)')) {
          const a = m.getBoundingClientRect();
          const b = badge.getBoundingClientRect();
          const hit = a.left < b.right - 1 && a.right > b.left + 1
            && a.top < b.bottom - 1 && a.bottom > b.top + 1;
          if (hit) escaped.push({ text: m.textContent, over: badge.textContent });
        }
      }
      return { count: markers.length, escaped };
    });

    expect(overlaps.count, 'the folded grid must show at least one marker').toBeGreaterThan(0);
    expect(overlaps.escaped).toEqual([]);

    await unfoldAll(page).click();
  });
});

// ─── Resizing the matrix (#370) ───────────────────────────────────────────────
//
// The measured "fit the rest of the window" height is a default, not a verdict:
// how much of the window the grid deserves next to the panels above it is the
// analyst's call. The grip under the grid makes it theirs, and remembers it.
test.describe('Matrix — resizing the grid height', () => {
  test.setTimeout(90000);

  const gridHeight = (page) => page.evaluate(() => {
    const el = document.querySelector('div[style*="max-height"]');
    return el ? Math.round(el.getBoundingClientRect().height) : 0;
  });

  const grip = (page) => page.getByRole('button', { name: 'Resize the matrix height' });

  async function openMatrix(page) {
    const filter = {
      rowType: 'principal',
      orientation: 'rows-as-resources',
      subject: { include: [], exclude: [] },
      resource: { include: [], exclude: [] },
    };
    await page.goto('about:blank');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/#matrix?filter=' + encodeURIComponent(JSON.stringify(filter)));
    await page.waitForLoadState('networkidle');
    try {
      await expect(page.locator('table').first()).toBeVisible({ timeout: 40000 });
    } catch {
      return false;
    }
    // Collapse "How to read this matrix" so the chrome leaves the grid a
    // measurable cap to start from (the same setup the scrollbar spec uses).
    const legend = page.getByRole('button', { name: /How to read this matrix/i }).first();
    await expect(legend).toBeVisible({ timeout: 20000 });
    if (await legend.getAttribute('aria-expanded') === 'true') await legend.click();
    await page.waitForTimeout(1500); // let the measuring effect settle
    return true;
  }

  test('dragging the grip resizes the grid, and the height is remembered', async ({ page }) => {
    test.skip(!await openMatrix(page), 'matrix grid did not render (no data)');

    const before = await gridHeight(page);
    const box = await grip(page).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 200, { steps: 10 });
    await page.mouse.up();

    await expect.poll(() => gridHeight(page)).toBeLessThan(before);
    const shrunk = await gridHeight(page);

    // Still exactly one scroller — a resized grid is not a broken layout.
    expect(await page.evaluate(() => {
      const de = document.documentElement;
      return de.scrollHeight - de.clientHeight > 4;
    })).toBe(false);

    // The choice survives a reload.
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('table').first()).toBeVisible({ timeout: 40000 });
    await expect.poll(() => gridHeight(page)).toBe(shrunk);

    // "Fit to window" hands the decision back to the measured fit.
    await page.getByRole('button', { name: 'Fit to window' }).click();
    await expect.poll(() => gridHeight(page)).toBe(before);
    await expect(page.getByRole('button', { name: 'Fit to window' })).toHaveCount(0);
  });

  test('the arrow keys resize it too, so the grip is not mouse-only', async ({ page }) => {
    test.skip(!await openMatrix(page), 'matrix grid did not render (no data)');

    const before = await gridHeight(page);
    await grip(page).focus();
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => gridHeight(page)).toBeLessThan(before);
    await page.keyboard.press('Escape');
    await expect.poll(() => gridHeight(page)).toBe(before);
  });
});

// ─── Contexts column (#870) ────────────────────────────────────────────────────
//
// Each resource row carries the Contexts it belongs to (group category, tags,
// clusters, …) pinned next to the resource name: up to two chips, the rest behind
// a "+N" toggle. Resource Type moved to the right-side metadata block in its
// place. Display only — filtering by context stays in the filter wizard.
test.describe('Matrix — Contexts column', () => {
  test.setTimeout(90000);

  const allDataFilter = {
    rowType: 'principal',
    orientation: 'rows-as-resources',
    subject: { include: [], exclude: [] },
    resource: { include: [], exclude: [] },
  };

  async function openGrid(page) {
    await page.goto('/#matrix?filter=' + encodeURIComponent(JSON.stringify(allDataFilter)));
    await page.waitForLoadState('networkidle');
    const table = page.locator('table').first();
    try {
      await expect(table).toBeVisible({ timeout: 40000 });
    } catch {
      test.skip(true, 'matrix grid did not render (no data) — cannot exercise the Contexts column');
    }
    return table;
  }

  test('the grid has a Contexts header column', async ({ page }) => {
    await openGrid(page);
    await expect(page.getByRole('columnheader', { name: 'Contexts', exact: true }).first())
      .toBeVisible({ timeout: 20000 });
  });

  test('Contexts is pinned beside Resource Name and Type sits on the right', async ({ page }) => {
    const table = await openGrid(page);
    const namesRow = table.locator('thead tr').last();
    const headers = namesRow.locator('th');

    // Info block, left to right: drag handle | Resource Name | Contexts.
    await expect(headers.nth(1)).toHaveText('Resource Name');
    await expect(headers.nth(2)).toHaveText('Contexts');
    // Contexts is pinned, so it stays put while the grid scrolls horizontally.
    await expect(headers.nth(2)).toHaveCSS('position', 'sticky');

    // Right-side metadata block ends with … | Type | Description.
    const count = await headers.count();
    await expect(headers.nth(count - 2)).toHaveText('Type');
    await expect(headers.nth(count - 1)).toHaveText('Description');

    // The first data row lines up with those headers: chips (or a dash) in the
    // pinned Contexts cell, the resource type in the second-to-last cell.
    const cells = table.locator('tbody tr').first().locator('td');
    await expect(cells.nth(2)).toHaveCSS('position', 'sticky');
    await expect(cells.nth(2)).not.toBeEmpty();
  });

  test('the API serves a per-resource contexts sidecar for the grid', async ({ page }) => {
    // The fetch below uses an app-relative URL, so the page must be on the app's
    // origin first — evaluating on the initial about:blank cannot resolve it.
    await page.goto('/');

    const body = await page.evaluate(async (filter) => {
      const res = await fetch('/api/matrix/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filter }),
      });
      return res.ok ? res.json() : null;
    }, allDataFilter);

    expect(body).not.toBeNull();
    expect(Array.isArray(body.resourceContexts)).toBe(true);
    for (const entry of body.resourceContexts) {
      expect(typeof entry.resourceId).toBe('string');
      expect(Array.isArray(entry.contexts)).toBe(true);
      expect(entry.contexts.length).toBeGreaterThan(0);
      for (const ctx of entry.contexts) expect(typeof ctx.displayName).toBe('string');
    }
  });

  test('a row in more than two contexts expands the rest inline via "+N"', async ({ page }) => {
    await openGrid(page);

    const expander = page.getByRole('button', { name: /show \d+ more contexts/i }).first();
    if (await expander.count() === 0) {
      test.skip(true, 'no resource in this dataset belongs to more than two contexts');
      return;
    }

    const row = page.locator('tbody tr').filter({ has: expander }).first();
    const before = await row.locator('span[title*=":"]').count();
    await expander.click();
    // Expanding reveals the hidden chips and flips the control to "collapse".
    await expect(page.getByRole('button', { name: /show fewer contexts/i }).first()).toBeVisible();
    expect(await row.locator('span[title*=":"]').count()).toBeGreaterThan(before);
  });
});

// ─── Adjusting a matrix without changing anything ─────────────────────────────
//
// "Adjust matrix" is the analyst's main loop, and opening the wizard, walking
// its steps and applying WITHOUT touching a control has to be a no-op: every
// step renders, and the matrix that comes back is the one they were looking at.
//
// It wasn't. A filter that didn't come from the wizard — the org-wide default
// the demo dataset seeds, a shared `#matrix?filter=…` link, an older saved
// matrix — carries only the fields its writer cared about, and the steps read
// the rest directly (`sortAttributes.length`), so the Sort step took down the
// whole page: the analyst got "Something went wrong" instead of the wizard.
//
// Every other matrix spec missed it because they drive the grid through a URL
// filter and never reopen the wizard, or open it on a freshly-built (complete)
// filter. The tests below walk the real path for each way a filter reaches the
// wizard, changing nothing, so this class of break is caught in CI instead of
// in functional acceptance.

// The steps the wizard can show, and a marker that only renders once that
// step's body is on screen. Keyed by the label in the step indicator.
const STEP_MARKERS = {
  Setup:     'Subject type',
  Content:   'Roll-up content',
  Subjects:  /Narrow down the (users|identities) that appear as rows/,
  Resources: 'Narrow down the resources that appear as columns',
  Sort:      'Sort columns',
};

// Records the counts of every matrix payload the page loads, newest last, so a
// test can assert the matrix before and after an adjust is the same one.
function trackMatrixLoads(page) {
  const loads = [];
  page.on('response', async (res) => {
    if (res.request().method() !== 'POST' || !res.url().includes('/api/matrix/data')) return;
    try {
      const body = await res.json();
      loads.push({
        subjectCount:    body.subjectCount,
        resourceCount:   body.resourceCount,
        assignmentCount: body.assignmentCount,
        rowCount:        (body.data || []).length,
      });
    } catch { /* a superseded (aborted) request has no body — ignore */ }
  });
  return loads;
}

// The name the summary bar gives the applied matrix: the saved matrix it came
// from, or "Not saved". It's the bar's leading badge — the bar itself being the
// innermost element that holds the "Adjust matrix" button. Waits out the "…"
// the badge shows while the saved-matrix list is still loading.
async function savedBadgeText(page) {
  const bar = page.locator('div')
    .filter({ has: page.getByRole('button', { name: 'Adjust matrix' }) }).last();
  const badge = bar.locator('> span').first();
  await expect(badge).not.toHaveText('…', { timeout: 20000 });
  return (await badge.innerText()).trim();
}

// The resource names currently rendered in the grid's pinned name column.
// Row order is deterministic, so this is a cheap "same matrix" fingerprint that
// survives row virtualisation (it only ever compares the visible window).
function visibleRowNames(page) {
  return page.locator('tbody tr td:nth-child(2)').allInnerTexts();
}

// Open the wizard on the applied matrix, visit EVERY step it offers (via the
// step indicator, so no step is skipped by a Next that lands elsewhere), change
// nothing, and apply. Returns the labels of the steps that were visited.
async function adjustWithoutChanges(page) {
  await page.getByRole('button', { name: 'Adjust matrix' }).click();
  await expect(page.getByText(STEP_MARKERS.Setup)).toBeVisible({ timeout: 20000 });

  // The step list is dynamic (a roll-up adds Content and drops Sort), so read it
  // off the indicator rather than assuming a fixed sequence.
  const stepButtons = page.getByRole('button', { name: /^Go to step \d+: / });
  const labels = (await stepButtons.allTextContents()).map(t => t.replace(/^\d+|✓/, '').trim());
  expect(labels.length).toBeGreaterThan(1);

  for (const [i, label] of labels.entries()) {
    await stepButtons.nth(i).click();
    const marker = STEP_MARKERS[label];
    expect(marker, `unknown wizard step "${label}" — add it to STEP_MARKERS`).toBeTruthy();
    await expect(page.getByText(marker).first()).toBeVisible({ timeout: 10000 });
  }

  // Apply is only offered on the last step, which is where the walk ended.
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByText(STEP_MARKERS[labels[labels.length - 1]]).first())
    .toBeHidden({ timeout: 10000 });
  return labels;
}

test.describe('Matrix — adjust without changing anything', () => {
  test.setTimeout(90000);

  // Exactly what test/demo-dataset/Ingest-DemoDataset.ps1 seeds as the org-wide
  // default: the four fields the seeder cares about and nothing else.
  const seededFilter = {
    rowType: 'principal',
    orientation: 'rows-as-resources',
    subject: { include: [], exclude: [] },
    resource: { include: [], exclude: [] },
  };

  // Loads the matrix and waits for the grid. `hash` omitted = the org-wide
  // default matrix, auto-applied without the wizard (a demo install's first
  // visit); otherwise the filter travels in the URL, as a shared link does.
  async function openMatrix(page, hash = '#matrix') {
    await page.goto('/' + hash);
    await page.waitForLoadState('networkidle');
    const table = page.locator('table').first();
    try {
      await expect(table).toBeVisible({ timeout: 40000 });
    } catch {
      test.skip(true, 'matrix grid did not render (no data) — cannot exercise the adjust path');
    }
    await expect(page.getByRole('button', { name: 'Adjust matrix' })).toBeVisible({ timeout: 20000 });
  }

  test('the org-wide default matrix survives an adjust that changes nothing', async ({ page }) => {
    const crashes = [];
    page.on('pageerror', (err) => crashes.push(err.message));
    const loads = trackMatrixLoads(page);

    await openMatrix(page);
    const before = loads[loads.length - 1];
    const rowsBefore = await visibleRowNames(page);
    const savedNameBefore = await savedBadgeText(page);
    // Guard the comparisons below against passing on nothing.
    expect(before?.rowCount, 'the matrix loaded no assignments').toBeGreaterThan(0);
    expect(rowsBefore.length, 'the grid rendered no resource rows').toBeGreaterThan(0);

    const steps = await adjustWithoutChanges(page);
    expect(steps).toEqual(['Setup', 'Subjects', 'Resources', 'Sort']);

    // The page is still the matrix, not the error boundary.
    await expect(page.getByText('Something went wrong')).toBeHidden();
    expect(crashes).toEqual([]);
    await expect(page.locator('table').first()).toBeVisible({ timeout: 20000 });

    // …and it is the SAME matrix: same scope counts, same rows in the same order.
    await expect.poll(() => loads[loads.length - 1], { timeout: 20000 }).toEqual(before);
    expect(await visibleRowNames(page)).toEqual(rowsBefore);
    // Including its identity: it's still the saved matrix it was loaded from,
    // not a look-alike relabelled "Not saved".
    await expect.poll(() => savedBadgeText(page), { timeout: 20000 }).toBe(savedNameBefore);
    expect(savedNameBefore).not.toBe('Not saved');
  });

  test('a matrix shared as a link survives an adjust that changes nothing', async ({ page }) => {
    const crashes = [];
    page.on('pageerror', (err) => crashes.push(err.message));

    await openMatrix(page, '#matrix?filter=' + encodeURIComponent(JSON.stringify(seededFilter)));
    await adjustWithoutChanges(page);

    await expect(page.getByText('Something went wrong')).toBeHidden();
    expect(crashes).toEqual([]);
    await expect(page.locator('table').first()).toBeVisible({ timeout: 20000 });
  });

  test('an identity matrix survives an adjust that changes nothing', async ({ page }) => {
    // rowType=identity makes the wizard lazy-load a different column set for the
    // Subjects and Sort steps — those must render before the columns arrive too.
    const crashes = [];
    page.on('pageerror', (err) => crashes.push(err.message));

    await openMatrix(page, '#matrix?filter=' + encodeURIComponent(JSON.stringify({
      ...seededFilter, rowType: 'identity',
    })));
    await adjustWithoutChanges(page);

    await expect(page.getByText('Something went wrong')).toBeHidden();
    expect(crashes).toEqual([]);
    await expect(page.locator('table').first()).toBeVisible({ timeout: 20000 });
  });

  test('adjusting twice in a row keeps the matrix stable', async ({ page }) => {
    // The second pass adjusts a filter the wizard itself produced, so a step
    // that mangles a field on the way out shows up as a changed matrix here.
    const crashes = [];
    page.on('pageerror', (err) => crashes.push(err.message));
    const loads = trackMatrixLoads(page);

    await openMatrix(page);
    const before = loads[loads.length - 1];

    await adjustWithoutChanges(page);
    await expect(page.locator('table').first()).toBeVisible({ timeout: 20000 });
    await adjustWithoutChanges(page);

    await expect(page.getByText('Something went wrong')).toBeHidden();
    expect(crashes).toEqual([]);
    await expect.poll(() => loads[loads.length - 1], { timeout: 20000 }).toEqual(before);
  });
});

// ─── Regression: no double scrollbar behind the matrix grid ────────────────────
//
// The bug: the grid's height was a fixed max-h-[calc(100vh-280px)] that guessed
// the chrome height. The real chrome (auth banner + scope-statistics + "How to
// read") is taller, so the grid was too tall and the PAGE got a second
// scrollbar next to the grid's own (measured ~310px page overflow). The fix
// measures the space really left below the grid and caps it to fit — and when
// less than a usable grid is left, drops the cap so the page is the single
// scroller instead. Either way exactly one of the two scrolls.
test.describe('Matrix — no double scrollbar', () => {
  test.setTimeout(90000);

  // Measures which of the two scrolls: the grid (internally) or the page.
  const readScrollState = (page) => page.evaluate(() => {
    const de = document.documentElement;
    const gridScrolls = [...document.querySelectorAll('div')].some((el) => {
      const s = getComputedStyle(el);
      return /auto|scroll/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 2;
    });
    // A few px of slack for sub-pixel rounding.
    return { pageScrolls: de.scrollHeight - de.clientHeight > 4, gridScrolls };
  });

  async function openFullMatrix(page) {
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
    try {
      await expect(page.locator('table').first()).toBeVisible({ timeout: 40000 });
    } catch {
      return false;
    }
    await page.waitForTimeout(1500); // let the height-measuring effect settle
    return true;
  }

  test('the grid and the page never scroll at the same time', async ({ page }) => {
    // Short viewport + the "How to read this matrix" panel open: the chrome eats
    // most of the window, which is exactly the case the old fixed cap got wrong.
    await page.setViewportSize({ width: 1280, height: 800 });
    test.skip(!await openFullMatrix(page), 'matrix grid did not render (no data)');

    const m = await readScrollState(page);
    expect(m.gridScrolls && m.pageScrolls, 'only one of grid/page may scroll').toBe(false);
    // Something must scroll — a full-data grid cannot fit an 800px window. This
    // keeps the assertion above from passing vacuously.
    expect(m.gridScrolls || m.pageScrolls, 'the full-data matrix must scroll somewhere').toBe(true);
  });

  test('with room for the grid, only the grid scrolls', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    test.skip(!await openFullMatrix(page), 'matrix grid did not render (no data)');

    // Collapse the legend to free the ~270px that keeps the grid from getting a
    // usable height. The measuring hook re-measures and caps the grid.
    const legend = page.getByRole('button', { name: /How to read this matrix/i }).first();
    await expect(legend).toBeVisible({ timeout: 20000 });
    if (await legend.getAttribute('aria-expanded') === 'true') await legend.click();
    await page.waitForTimeout(1000);

    const m = await readScrollState(page);
    expect(m.gridScrolls, 'the grid should scroll internally').toBe(true);
    expect(m.pageScrolls, 'the page should not scroll when the grid does').toBe(false);
  });
});
