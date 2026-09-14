// @ts-check
//
// Expanding an identity column in the matrix — issue #1212.
//
// The reporter's path: Matrix → subjects are Identities → click the ▸ "Expand
// into linked accounts" control on an identity column header. The accounts used
// to be spliced in as extra sibling columns to the RIGHT of the identity, in the
// same header row. They now hang UNDER it: the identity's header cell spans one
// column per account, and a second header row below carries the account labels.
// Expanding replaces the identity's own (combined) column — collapsing again is
// how the analyst gets it back.
//
// Dataset-independent — the identity under test is read from the deployment
// (the demo dataset correlates SAP accounts to 10 identities), and the spec
// skips when nothing on screen has a second account to expand into.

import { test, expect } from '@playwright/test';
import { API } from './matrixWizard.js';

// An identity matrix, applied straight from the hash so the wizard is not in the
// way. Matches the shape the seeder writes as the org-wide default.
const IDENTITY_FILTER = {
  rowType: 'identity',
  orientation: 'rows-as-resources',
  subject: { include: [], exclude: [] },
  resource: { include: [], exclude: [] },
};

// Identities with more than one linked account, most accounts first — the ones
// that have something to expand into.
async function correlatedIdentities() {
  const res = await fetch(`${API}/identities?sort=accountCount&dir=desc&limit=10`);
  if (!res.ok) return [];
  const body = await res.json();
  return (body?.data || []).filter(i => (i.accountCount ?? 0) > 1 && i.displayName);
}

async function openIdentityMatrix(page) {
  await page.goto('/#matrix?filter=' + encodeURIComponent(JSON.stringify(IDENTITY_FILTER)));
  await page.waitForLoadState('networkidle');
  try {
    await expect(page.locator('table').first()).toBeVisible({ timeout: 40000 });
  } catch {
    test.skip(true, 'matrix grid did not render (no data) — cannot expand an identity');
  }
}

// Expand the first identity that both has several accounts and has a column in
// the grid. Returns its display name, or null when there is no such column.
async function expandAnIdentity(page) {
  const correlated = new Set((await correlatedIdentities()).map(i => i.displayName));
  if (!correlated.size) return null;

  // Every identity column carries the expand control; its header tooltip reads
  // "<name>\n<jobTitle>\n<department>".
  const headers = page.locator('thead th')
    .filter({ has: page.getByTitle('Expand into linked accounts') });
  const count = await headers.count();
  for (let i = 0; i < count; i++) {
    const header = headers.nth(i);
    const name = ((await header.getAttribute('title')) || '').split('\n')[0];
    if (!correlated.has(name)) continue;
    await header.getByTitle('Expand into linked accounts').click();
    // The control flips once the account columns are in — the fetch behind it
    // can take a moment on a cold API.
    await expect(page.getByTitle('Collapse accounts').first()).toBeVisible({ timeout: 30000 });
    return name;
  }
  return null;
}

// The header as a grid: how many columns each <tr> covers, counting a cell's
// colspan on each of the rows its rowspan reaches. Plus the width of the widest
// body row, which every header row has to match.
const headerGeometry = (page) => page.evaluate(() => {
  const table = document.querySelector('table');
  const rows = [...table.querySelectorAll('thead tr')];
  const width = new Array(rows.length).fill(0);
  rows.forEach((tr, r) => {
    for (const th of tr.children) {
      const cols = Number(th.getAttribute('colspan')) || 1;
      const span = Number(th.getAttribute('rowspan')) || 1;
      for (let i = 0; i < span && r + i < width.length; i++) width[r + i] += cols;
    }
  });
  const bodyWidth = [...table.querySelectorAll('tbody tr')].slice(0, 5).map(tr =>
    [...tr.children].reduce((n, td) => n + (Number(td.getAttribute('colspan')) || 1), 0));
  return { width, bodyWidth };
});

test.describe('Matrix — expanding an identity into its accounts (#1212)', () => {
  test.setTimeout(90000);

  test('the accounts appear in a header row under the identity, not beside it', async ({ page }) => {
    await openIdentityMatrix(page);

    const headerRows = page.locator('thead tr');
    const rowsBefore = await headerRows.count();
    // No identity is expanded yet, so neither the accounts row nor any account
    // column can be on screen.
    await expect(page.locator('thead th[title*="(account"]')).toHaveCount(0);

    const name = await expandAnIdentity(page);
    test.skip(!name, 'no identity with several linked accounts has a column in this grid');

    // Expanding added exactly one header row: the accounts row.
    await expect(headerRows).toHaveCount(rowsBefore + 1);

    const namesRow = headerRows.nth(rowsBefore - 1);
    const accountsRow = headerRows.nth(rowsBefore);

    // Every account label is in the row BELOW — this is the whole of the report.
    const accountCells = accountsRow.locator('th[title*="(account"]');
    await expect.poll(() => accountCells.count()).toBeGreaterThan(1);
    // The names row holds none of them any more.
    await expect(namesRow.locator('th[title*="(account"]')).toHaveCount(0);

    // The identity spans exactly its accounts: it no longer keeps a column of
    // its own ("All accounts") next to them.
    const identityCell = namesRow.locator('th').filter({ has: page.getByTitle('Collapse accounts') }).first();
    expect(Number(await identityCell.getAttribute('colspan'))).toBe(await accountCells.count());
    await expect(page.locator('thead').getByText('All accounts')).toHaveCount(0);
  });

  test('the expanded header still lines up with the grid underneath it', async ({ page }) => {
    await openIdentityMatrix(page);
    const name = await expandAnIdentity(page);
    test.skip(!name, 'no identity with several linked accounts has a column in this grid');

    // A colspan/rowspan that doesn't add up shifts every body cell beside the
    // expanded identity one column over — the badges would read off the wrong
    // subject, which is worse than the layout this fixes.
    const { width, bodyWidth } = await headerGeometry(page);
    expect(bodyWidth.length, 'the grid rendered no resource rows').toBeGreaterThan(0);
    const expected = Math.max(...bodyWidth);
    expect(width).toEqual(new Array(width.length).fill(expected));
  });

  test('the accounts row pins with the names row and leaves no grey band on scroll', async ({ page }) => {
    await openIdentityMatrix(page);

    // The sticky <thead> carries a negative top equal to the GROUPING rows'
    // height, so the names row comes to rest at the top. The accounts row sits
    // after the names row and pins with it — counting it into that offset would
    // push the header out of view and leave the blank band of #1049.
    const thead = page.locator('thead').first();
    const offsetBefore = await thead.evaluate(el => getComputedStyle(el).top);

    const name = await expandAnIdentity(page);
    test.skip(!name, 'no identity with several linked accounts has a column in this grid');
    expect(await thead.evaluate(el => getComputedStyle(el).top)).toBe(offsetBefore);

    // Scroll the grid to the bottom: the header is still on screen, and the
    // accounts row with it.
    const scroller = page.locator('div[style*="max-height"]').first();
    await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect(page.getByTitle('Collapse accounts').first()).toBeVisible();
    await expect(page.locator('thead th[title*="(account"]').first()).toBeVisible();
  });

  test('collapsing the identity brings its combined column back', async ({ page }) => {
    await openIdentityMatrix(page);
    const name = await expandAnIdentity(page);
    test.skip(!name, 'no identity with several linked accounts has a column in this grid');

    const headerRows = page.locator('thead tr');
    const expanded = await headerRows.count();

    // Collapsing is the only way back to the identity's combined view, so it has
    // to drop the accounts row and every account column with it.
    await page.getByTitle('Collapse accounts').first().click();
    await expect(headerRows).toHaveCount(expanded - 1);
    await expect(page.locator('thead th[title*="(account"]')).toHaveCount(0);
    await expect(page.getByTitle('Expand into linked accounts').first()).toBeVisible();
  });
});
