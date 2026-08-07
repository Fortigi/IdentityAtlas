// @ts-check
/**
 * Issue #943 — the Filters bar must name the tag you actually clicked.
 *
 * Walks the reporter's path in the browser: create + assign a tag, reload,
 * then create + assign a SECOND tag without reloading and select it. Before
 * the fix the filter options were a mount-time snapshot, so the second tag
 * was missing from them and the pill's <select> fell back to displaying the
 * alphabetically first option ("AAA-…") while the table correctly showed the
 * second tag's resources.
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3001';
const API = `${BASE}/api`;

const FIRST_TAG = 'e2e943-aaa-first';
const SECOND_TAG = 'e2e943-zzz-second';

/** Delete both test tags via the API, ignoring ones that don't exist. */
async function cleanupTags(request) {
  const res = await request.get(`${API}/tags?entityType=resource`);
  if (!res.ok()) return;
  const body = await res.json();
  const tags = Array.isArray(body) ? body : (body.data ?? body.tags ?? []);
  for (const t of tags.filter(t => t.name === FIRST_TAG || t.name === SECOND_TAG)) {
    await request.delete(`${API}/tags/${t.id}`);
  }
}

/** Create a tag through the page's "+ New Tag" form. */
async function createTag(page, name) {
  await page.getByRole('button', { name: '+ New Tag' }).click();
  await page.getByPlaceholder('Tag name...').fill(name);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText(new RegExp(`${name}\\s*\\(`))).toBeVisible();
}

/** Select the first two rows and assign `name` to them. */
async function assignTagToFirstRows(page, name) {
  const checkboxes = page.locator('table tbody tr input[type="checkbox"]');
  const rows = Math.min(2, await checkboxes.count());
  for (let i = 0; i < rows; i++) await checkboxes.nth(i).check();

  const tagSelect = page.getByRole('combobox').filter({ hasText: 'Select tag...' });
  await tagSelect.selectOption({ label: name });
  await page.getByRole('button', { name: 'Assign Tag' }).click();
  // The action bar clears its tag select once the assignment round-trips.
  await expect(tagSelect).toHaveValue('');
}

test.describe('Resource tag filter label (issue #943)', () => {
  test.beforeEach(async ({ request }) => cleanupTags(request));
  test.afterEach(async ({ request }) => cleanupTags(request));

  test('the Filters pill names the tag that was just created and selected', async ({ page, request }) => {
    const resRes = await request.get(`${API}/resources?limit=1`);
    const resBody = await resRes.json();
    const resources = Array.isArray(resBody) ? resBody : (resBody.data ?? []);
    // Nothing to tag on an empty deployment — this needs the demo dataset.
    test.skip(resources.length === 0, 'no resources in this deployment');

    await page.goto(`${BASE}/#resources`);
    await page.waitForSelector('table tbody tr');

    // 1. First tag — created, assigned, then baked into the filter options by a reload.
    await createTag(page, FIRST_TAG);
    await assignTagToFirstRows(page, FIRST_TAG);

    await page.reload();
    await page.waitForSelector('table tbody tr');

    // 2. Second tag — created and assigned in THIS session, no reload after it.
    await createTag(page, SECOND_TAG);
    await assignTagToFirstRows(page, SECOND_TAG);

    // 3. Filter by the second tag from the tag bar.
    await page.getByText(new RegExp(`^${SECOND_TAG}\\s*\\(`)).click();

    // The Filters bar must read back the tag that is actually filtering the
    // table — not the alphabetically first tag in a stale options snapshot.
    const activePill = page.locator('span:has(> span:text-is("Resource Tag:")) select');
    await expect(activePill).toBeVisible();
    await expect(activePill).toHaveValue(SECOND_TAG);
    await expect(activePill).not.toHaveValue(FIRST_TAG);

    // And the rows really are the second tag's resources.
    const firstRowTags = page.locator('table tbody tr').first();
    await expect(firstRowTags).toContainText(SECOND_TAG);
  });
});
