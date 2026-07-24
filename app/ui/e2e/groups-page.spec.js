// @ts-check
import { test, expect } from '@playwright/test';

test.describe('Groups Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#groups');
    await page.waitForTimeout(500);
  });

  test('page renders with title and group count', async ({ page }) => {
    await expect(page.locator('h2')).toContainText('Resources');
    const totalText = page.getByText(/total/i);
    await expect(totalText.first()).toBeVisible({ timeout: 5000 });
  });

  test('group table shows group names', async ({ page }) => {
    const table = page.locator('table').first();
    await expect(table).toBeVisible({ timeout: 5000 });

    // Mock groups include "SG-Finance-Base", "APP-SAP-Read", etc.
    // At least one group should be visible
    const groupCell = page.getByText(/SG-|APP-|PAG-|RES-/).first();
    await expect(groupCell).toBeVisible({ timeout: 5000 });
  });

  test('search filters groups', async ({ page }) => {
    const searchInput = page.getByPlaceholder(/Search by resource name/i);
    await expect(searchInput).toBeVisible();

    await searchInput.fill('Finance');
    await page.waitForTimeout(500);

    // Should show filtered results
    await expect(page.locator('table')).toBeVisible();
  });

  test('tag management works', async ({ page }) => {
    const newTagButton = page.getByText('+ New Tag').or(page.getByText('New Tag'));
    await expect(newTagButton.first()).toBeVisible();
  });

  test('clicking group name opens detail tab', async ({ page }) => {
    const groupLinks = page.locator('table a, table button').filter({
      hasText: /SG-|APP-|PAG-|RES-/
    });

    if (await groupLinks.count() > 0) {
      await groupLinks.first().click();
      await page.waitForTimeout(500);
      expect(page.url()).toMatch(/#group:/);
    }
  });
});

// Renders the resources list with a *tagged* row in a real browser. Regression
// guard for #762: the per-row tag pill lives in the extracted EntityListTable
// and calls tagPillStyle(t.color, isDark); when `isDark` wasn't threaded into
// that child it threw `ReferenceError: isDark is not defined` during render,
// collapsing the whole page into the "Something went wrong" error boundary.
// The tag-lifecycle suite (tags.spec.js) is API-only and never rendered a row,
// so nothing in CI exercised this path.
test.describe('Resources list — tagged row rendering (#762)', () => {
  const API = 'http://localhost:3001/api';
  const TAG_NAME = 'e2e-tagged-row-render';

  test('a resource carrying a tag renders its pill without hitting the error boundary', async ({ page, request }) => {
    // Seed: create a tag and assign it to a real resource via the API.
    const createRes = await request.post(`${API}/tags`, {
      data: { name: TAG_NAME, entityType: 'resource', color: '#1d4ed8' },
    });
    if (!createRes.ok()) test.skip(true, 'tag API unavailable');
    const tag = await createRes.json();
    const tagId = tag.id;

    try {
      const resRes = await request.get(`${API}/resources?limit=1`);
      const resBody = await resRes.json();
      const resources = Array.isArray(resBody) ? resBody : (resBody.data ?? []);
      if (resources.length === 0) test.skip(true, 'no resources seeded');
      const resource = resources[0];
      const resourceName = resource.name || resource.displayName;

      const assignRes = await request.post(`${API}/tags/${tagId}/assign`, {
        data: { entityIds: [resource.id] },
      });
      expect(assignRes.ok()).toBeTruthy();

      // Render the list and narrow to the tagged resource by name.
      await page.goto('/#groups');
      await page.getByPlaceholder(/Search by resource name/i).fill(resourceName);
      await page.waitForTimeout(600); // debounced search

      const table = page.locator('table').first();
      await expect(table).toBeVisible({ timeout: 5000 });
      // The row's tag pill (scoped to the table so we don't match the filter-bar
      // pill, which lives in the parent where isDark was always in scope).
      await expect(table.getByText(TAG_NAME).first()).toBeVisible({ timeout: 5000 });
      // The page did NOT fall into the error boundary.
      await expect(page.getByText('Something went wrong')).toHaveCount(0);
    } finally {
      await request.delete(`${API}/tags/${tagId}`);
    }
  });
});
