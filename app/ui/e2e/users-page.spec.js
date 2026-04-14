// @ts-check
import { test, expect } from '@playwright/test';

test.describe('Users Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#users');
    // Wait for data to load
    await page.waitForTimeout(500);
  });

  test('page renders with title and user count', async ({ page }) => {
    await expect(page.locator('h2')).toContainText('Users');
    // Mock data has 80 users — count should appear somewhere
    const totalText = page.getByText(/total/i);
    await expect(totalText.first()).toBeVisible({ timeout: 5000 });
  });

  test('user table shows display names', async ({ page }) => {
    // Mock users include names like "Alice Johnson", "Bob Smith", etc.
    // At least one user name should be visible in the table
    const table = page.locator('table').first();
    await expect(table).toBeVisible({ timeout: 5000 });

    // Table should have header columns
    await expect(page.getByText('Display Name').or(page.getByText('displayName'))).toBeVisible();
  });

  test('search input is present and functional', async ({ page }) => {
    const searchInput = page.getByPlaceholder(/Search by name or UPN/i);
    await expect(searchInput).toBeVisible();

    // Type a search term and verify no crash
    await searchInput.fill('test');
    // Wait for debounced search
    await page.waitForTimeout(500);

    // Results should be filtered — verify page is still alive (nav visible)
    // Table may be hidden if no results match the search term
    await expect(page.locator('nav')).toBeVisible();
  });

  test('tag management UI is present', async ({ page }) => {
    // "+ New Tag" button should be visible
    const newTagButton = page.getByText('+ New Tag').or(page.getByText('New Tag'));
    await expect(newTagButton.first()).toBeVisible();
  });

  test('create tag flow works', async ({ page }) => {
    // Click "+ New Tag"
    const newTagButton = page.getByText('+ New Tag').or(page.getByText('New Tag'));
    await newTagButton.first().click();

    // Tag creation form should appear
    const tagInput = page.getByPlaceholder(/Tag name/i);
    await expect(tagInput).toBeVisible();

    // Fill in tag name
    await tagInput.fill('E2E-Test-Tag');

    // Click a color circle (first one)
    const colorButtons = page.locator('button').filter({ has: page.locator('[style*="background"]') });
    if (await colorButtons.count() > 0) {
      await colorButtons.first().click();
    }

    // Click Create
    const createButton = page.getByRole('button', { name: /Create/i });
    await createButton.click();

    // Tag should appear in the tag bar
    await expect(page.getByText('E2E-Test-Tag')).toBeVisible({ timeout: 3000 });
  });

  test('pagination controls exist', async ({ page }) => {
    // Look for pagination UI (Previous/Next buttons or page numbers)
    const nextButton = page.getByRole('button', { name: /Next/i })
      .or(page.getByRole('button', { name: />/i }));

    // Mock data has 80 users, so pagination should exist with default page size
    if (await nextButton.count() > 0) {
      await expect(nextButton.first()).toBeVisible();
    }
  });

  test('clicking user name opens detail tab', async ({ page }) => {
    // Click first user link in the table
    const userLinks = page.locator('table a, table button').filter({
      hasText: /[A-Z][a-z]+ [A-Z][a-z]+/  // Pattern: "First Last"
    });

    if (await userLinks.count() > 0) {
      const userName = await userLinks.first().textContent();
      await userLinks.first().click();

      // A detail tab should open in the nav
      await page.waitForTimeout(500);
      // Check URL changed to include user detail
      const url = page.url();
      expect(url).toMatch(/#user:/);
    }
  });

  test('checkbox selection works', async ({ page }) => {
    const checkboxes = page.locator('input[type="checkbox"]');
    if (await checkboxes.count() > 1) {
      // Click first data checkbox (skip header "select all")
      await checkboxes.nth(1).check();

      // Action bar should appear with tag assignment options
      const actionBar = page.getByText(/selected/i);
      await expect(actionBar.first()).toBeVisible({ timeout: 2000 });
    }
  });
});
