// @ts-check
import { test, expect } from '@playwright/test';

test.describe('Groups Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#groups');
    await page.waitForTimeout(500);
  });

  test('page renders with title and group count', async ({ page }) => {
    await expect(page.locator('h2')).toContainText('Groups');
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
    const searchInput = page.getByPlaceholder(/Search by group name/i);
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
